const express = require('express');
const axios = require('axios');
const { createHash, timingSafeEqual, randomUUID } = require('node:crypto');

const EVENTS = new Set(['conversation_created', 'conversation_updated']);
const RELEASE_LOCK = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
const LOCK_SECONDS = 60;
const DEDUP_SECONDS = 86400;

function positiveId(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (!/^[1-9]\d*$/.test(String(value))) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

function configuration(env) {
  let url;
  try { url = new URL(env.QDESK_URL || 'https://suporte.questor.com.br'); } catch { /* invalid */ }
  const config = {
    enabled: env.QDESK_ENABLED === 'true',
    dryRun: env.QDESK_DRY_RUN !== 'false',
    url: url?.origin,
    token: env.QDESK_API_ACCESS_TOKEN,
    secret: env.QDESK_WEBHOOK_SECRET,
    account: positiveId(env.QDESK_ACCOUNT_ID ?? 15),
    source: positiveId(env.QDESK_SOURCE_TEAM_ID ?? 129),
    general: positiveId(env.QDESK_GENERAL_GROUP_ID ?? 175),
    target: positiveId(env.QDESK_TARGET_TEAM_ID ?? 151)
  };
  config.valid = Boolean(url && url.protocol === 'https:' && !url.username && !url.password &&
    url.pathname === '/' && !url.search && !url.hash && config.token &&
    typeof config.secret === 'string' && Buffer.byteLength(config.secret) >= 32 &&
    config.account && config.source && config.general && config.target && config.source !== config.target &&
    ['true', 'false'].includes(env.QDESK_DRY_RUN ?? 'true'));
  return config;
}

function equalSecret(actual, expected) {
  if (typeof actual !== 'string') return false;
  // Hashes de tamanho fixo evitam diferenças de comprimento no timingSafeEqual.
  const hash = value => createHash('sha256').update(value).digest();
  return timingSafeEqual(hash(actual), hash(expected));
}

// Somente caminhos conhecidos e tipos. Nunca registra valores ou nomes de chaves arbitrárias.
function structure(body) {
  const paths = ['event', 'id', 'account.id', 'account_id', 'conversation.id',
    'conversation.account_id', 'conversation.account.id', 'meta.team.id',
    'meta.sender.company.group_company.id', 'conversation.meta.team.id',
    'conversation.meta.sender.company.group_company.id', 'payload.id', 'data.id'];
  return Object.fromEntries(paths.map(path => {
    const value = path.split('.').reduce((item, key) => item?.[key], body);
    return [path, value === undefined ? 'missing' : value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value];
  }));
}

// Adaptador explícito para eventos de conversa. Formatos desconhecidos nunca acionam a API.
function identifyEvent(body, authenticatedAccount) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || !EVENTS.has(body.event)) return null;
  const conversation = positiveId(body.id);
  if (!conversation) return null;
  // Executado somente após autenticar o segredo deste endpoint/conta.
  // Nenhum identificador do payload pode escolher a conta usada na API.
  for (const explicitAccount of [body.account?.id, body.account_id]) {
    if (explicitAccount !== undefined && positiveId(explicitAccount) !== authenticatedAccount) return null;
  }
  return { account: authenticatedAccount, conversation, event: body.event };
}

function createQdeskRouter({ redis, env = process.env, http = axios, logger = console } = {}) {
  const router = express.Router();
  const config = configuration(env);
  const log = details => logger.info('[qdesk]', details);

  router.post('/', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!config.enabled) return res.status(503).json({ status: 'disabled' });
    if (!config.valid || !redis) return res.status(503).json({ status: 'unavailable' });
    const authorization = req.get('authorization');
    const supplied = authorization?.startsWith('Bearer ') ? authorization.slice(7) : req.query.secret;
    if (!equalSecret(supplied, config.secret)) return res.status(401).json({ status: 'unauthorized' });
    if (!req.is('application/json')) return res.status(415).json({ status: 'json_required' });
    return next();
  }, express.json({ limit: '256kb', strict: true }), async (req, res) => {
    const identity = identifyEvent(req.body, config.account);
    if (!identity) {
      log({ decision: 'unsupported_event_shape', structure: structure(req.body) });
      return res.status(200).json({ status: 'ignored', reason: 'unsupported_event_shape' });
    }

    const context = { account: identity.account, conversation: identity.conversation, event: identity.event, dryRun: config.dryRun };
    const base = `qdesk:${config.account}:${identity.conversation}`;
    const fingerprint = createHash('sha256').update(JSON.stringify(req.body)).digest('hex');
    const eventKey = `${base}:event:${config.dryRun ? 'dry' : 'live'}:${fingerprint}`;
    const lockKey = `${base}:lock`;
    const owner = randomUUID();
    let locked = false;
    let phase = 'redis';
    try {
      locked = (await redis.set(lockKey, owner, 'EX', LOCK_SECONDS, 'NX')) === 'OK';
      if (!locked) return res.status(503).json({ status: 'busy', retryable: true });
      if (await redis.get(eventKey)) return res.status(200).json({ status: 'duplicate' });

      const api = `${config.url}/api/v1/accounts/${config.account}/conversations/${identity.conversation}`;
      const options = {
        headers: { api_access_token: config.token, 'Content-Type': 'application/json' },
        timeout: 10000, maxRedirects: 0, maxContentLength: 2 * 1024 * 1024
      };
      phase = 'read_conversation';
      const { data: conversation } = await http.get(api, options);
      if (!conversation || positiveId(conversation.id) !== identity.conversation ||
          (conversation.account_id !== undefined && positiveId(conversation.account_id) !== config.account) ||
          (conversation.account?.id !== undefined && positiveId(conversation.account.id) !== config.account)) {
        throw new Error('invalid_conversation_response');
      }
      const team = positiveId(conversation.meta?.team?.id);
      const group = positiveId(conversation.meta?.sender?.company?.group_company?.id);
      const matches = team === config.source && group !== null && group !== config.general;
      let decision = !team || !group ? 'missing_team_or_group' : matches ? 'would_transfer' : 'no_change';
      if (matches && !config.dryRun) {
        phase = 'verify_lock';
        if (await redis.get(lockKey) !== owner) throw new Error('lock_lost');
        phase = 'assign';
        await http.post(`${api}/assignments`, { team_id: config.target }, options);
        decision = 'transferred';
      }
      log({ ...context, decision, team, group });
      // Dados ausentes podem ser enriquecidos antes de uma reentrega do mesmo evento.
      if (team && group) {
        phase = 'mark_event';
        await redis.set(eventKey, '1', 'EX', DEDUP_SECONDS);
      }
      return res.status(200).json({ status: 'processed', decision });
    } catch (error) {
      // Nunca registrar objeto Axios, URL recebida, corpo, headers ou mensagem externa.
      log({ ...context, decision: 'failed', phase, upstreamStatus: Number.isInteger(error.response?.status) ? error.response.status : null });
      return res.status(503).json({ status: 'retryable_failure' });
    } finally {
      if (locked) {
        try { await redis.eval(RELEASE_LOCK, 1, lockKey, owner); }
        catch { log({ ...context, decision: 'lock_release_failed' }); }
      }
    }
  });

  router.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = error.type === 'entity.too.large' ? 413 : 400;
    return res.status(status).json({ status: status === 413 ? 'payload_too_large' : 'invalid_json' });
  });
  return router;
}

module.exports = { createQdeskRouter, positiveId, structure };
