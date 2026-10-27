const express = require('express');
const axios = require('axios');
const { createHash, timingSafeEqual, randomUUID } = require('node:crypto');

const EVENTS = new Set(['conversation_created', 'conversation_updated']);
const RELEASE_LOCK = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
const LOCK_SECONDS = 60;
const DEDUP_SECONDS = 86400;
const STATE_WINDOW_MS = 2000;
const READ_SUMMARY = "local result = redis.call('HGETALL', KEYS[1]); redis.call('DEL', KEYS[1]); return result";
const INCREMENT_SUMMARY = "local value = redis.call('HINCRBY', KEYS[1], ARGV[1], 1); if redis.call('TTL', KEYS[1]) < 0 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end; return value";
const SUMMARY_TTL_SECONDS = 300;

function routingRecordDecision(body, record, rule, now) {
  if (!record || record.schema !== 1 || record.rule !== rule) return 'rules_changed';
  if (!Number.isFinite(record.expiresAt) || record.expiresAt <= now) return 'expired';
  const team = positiveId(body.meta?.team?.id);
  const group = positiveId(body.meta?.sender?.company?.group_company?.id);
  if (!team || !group) return 'incomplete_event';
  if (team !== record.team || group !== record.group) return 'team_or_group_changed';
  const eventVersion = version(body.updated_at);
  const confirmedVersion = version(record.version);
  if (!eventVersion || !confirmedVersion || eventVersion < confirmedVersion ||
      eventVersion < (version(record.lastEventVersion) || confirmedVersion)) return 'uncertain_event';
  // Snapshot completo permite comparação mesmo se changed_attributes não vier no evento.
  if (body.changed_attributes === undefined) return 'reuse';
  if (!Array.isArray(body.changed_attributes)) return 'uncertain_event';
  const irrelevant = new Set(['status', 'priority', 'assignee_id', 'assignee_agent_bot_id',
    'snoozed_until', 'label_list', 'waiting_since', 'first_reply_created_at']);
  for (const change of body.changed_attributes) {
    if (!change || typeof change !== 'object' || Array.isArray(change) || !Object.keys(change).length) return 'uncertain_event';
    for (const [key, delta] of Object.entries(change)) {
      if (!irrelevant.has(key)) return 'relevant_or_unknown_change';
      if (!delta || typeof delta !== 'object' || !Object.hasOwn(delta, 'current_value') ||
          !Object.hasOwn(delta, 'previous_value')) return 'uncertain_event';
      if (Object.hasOwn(body, key) && stableJson(body[key]) !== stableJson(delta.current_value)) return 'uncertain_event';
    }
  }
  return 'reuse';
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function version(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (!/^\d+(\.\d+)?$/.test(String(value))) return null;
  const result = Number(value);
  return Number.isFinite(result) && result > 0 ? result : null;
}

function canSuppress(body, cached, source, now) {
  if (!cached || !positiveId(cached.team) || !positiveId(cached.group) ||
      !Number.isFinite(cached.confirmedAt) || now < cached.confirmedAt ||
      now - cached.confirmedAt >= STATE_WINDOW_MS) return false;
  const team = positiveId(body.meta?.team?.id);
  const group = positiveId(body.meta?.sender?.company?.group_company?.id);
  const eventVersion = version(body.updated_at);
  const confirmedVersion = version(cached.version);
  if (!team || !group || team === source || team !== cached.team || group !== cached.group ||
      !eventVersion || !confirmedVersion || eventVersion < confirmedVersion ||
      eventVersion < (version(cached.lastEventVersion) || confirmedVersion)) return false;
  // Somente atributos explicitamente conhecidos como irrelevantes podem reutilizar estado.
  const safeAttributes = new Set(['status', 'priority']);
  if (!Array.isArray(body.changed_attributes)) return false;
  if (eventVersion > confirmedVersion && body.changed_attributes.length === 0) return false;
  return body.changed_attributes.every(change => {
    if (!change || typeof change !== 'object' || Array.isArray(change)) return false;
    const keys = Object.keys(change);
    return keys.length > 0 && keys.every(key => {
      const delta = change[key];
      return safeAttributes.has(key) && delta && typeof delta === 'object' && !Array.isArray(delta) &&
        Object.hasOwn(delta, 'current_value') && Object.hasOwn(delta, 'previous_value') &&
        Object.hasOwn(body, key) && delta.current_value === body[key];
    });
  });
}

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

function requestOptions(config) {
  return {
    headers: { api_access_token: config.token, 'Content-Type': 'application/json' },
    timeout: 10000, maxRedirects: 0, maxContentLength: 2 * 1024 * 1024
  };
}

function transferConversation(http, api, team, options) {
  return http.post(`${api}/assignments`, { team_id: team }, options);
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

function createQdeskRouter({ redis, env = process.env, http = axios, logger = console, now = Date.now } = {}) {
  const router = express.Router();
  const config = configuration(env);
  const log = details => logger.info('[qdesk]', details);
  const ttlDays = positiveId(env.QDESK_ROUTING_PROCESSED_TTL_DAYS ?? 30);
  const ttlSeconds = ttlDays && ttlDays <= 3650 ? ttlDays * 86400 : null;
  const mode = config.dryRun ? 'dry' : 'live';
  const rule = createHash('sha256').update(stableJson({ source: config.source, general: config.general,
    target: config.target, mode, url: config.url })).digest('hex');
  const summaryKey = `qdesk:routing:summary:${config.account}:${mode}`;
  const count = field => redis.eval(INCREMENT_SUMMARY, 1, summaryKey, field, SUMMARY_TTL_SECONDS);
  async function flushRoutingSummary() {
    if (!config.enabled || !redis) return;
    try {
      const entries = await redis.eval(READ_SUMMARY, 1, summaryKey);
      if (!entries?.length) return;
      const totals = Object.fromEntries(Array.from({ length: entries.length / 2 }, (_, i) =>
        [entries[i * 2], Number(entries[i * 2 + 1])]));
      logger.info('[qdesk-routing-summary]', { account: config.account, dryRun: config.dryRun,
        received: totals.received || 0, alreadyProcessed: totals.alreadyProcessed || 0,
        validated: totals.validated || 0, transfers: totals.transfers || 0, errors: totals.errors || 0 });
    } catch { log({ decision: 'summary_failed', reason: 'redis_failure' }); }
  }
  const summaryTimer = config.enabled && redis ? setInterval(() => { void flushRoutingSummary(); }, 60000) : null;
  summaryTimer?.unref?.();
  router.flushRoutingSummary = flushRoutingSummary;
  router.stopRoutingSummary = () => clearInterval(summaryTimer);

  router.post('/', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!config.enabled) return res.status(503).json({ status: 'disabled' });
    if (!config.valid || !ttlSeconds || !redis) {
      if (!redis) log({ decision: 'failed', phase: 'redis', reason: 'redis_not_configured' });
      return res.status(503).json({ status: 'unavailable' });
    }
    const authorization = req.get('authorization');
    const supplied = authorization?.startsWith('Bearer ') ? authorization.slice(7) : req.query.secret;
    if (!equalSecret(supplied, config.secret)) return res.status(401).json({ status: 'unauthorized' });
    if (!req.is('application/json')) return res.status(415).json({ status: 'json_required' });
    return next();
  }, express.json({ limit: '256kb', strict: true }), async (req, res, next) => {
    try { await count('received'); return next(); }
    catch {
      log({ decision: 'failed', phase: 'metrics', reason: 'redis_failure' });
      return res.status(503).json({ status: 'retryable_failure' });
    }
  }, async (req, res) => {
    const identity = identifyEvent(req.body, config.account);
    if (!identity) {
      log({ decision: 'unsupported_event_shape', structure: structure(req.body) });
      return res.status(200).json({ status: 'ignored', reason: 'unsupported_event_shape' });
    }

    const context = { account: identity.account, conversation: identity.conversation, event: identity.event, dryRun: config.dryRun };
    const base = `qdesk:${config.account}:${identity.conversation}`;
    const fingerprint = createHash('sha256').update(stableJson(req.body)).digest('hex');
    const eventKey = `${base}:event:${config.dryRun ? 'dry' : 'live'}:${fingerprint}`;
    const lockKey = `${base}:lock`;
    const stateKey = `${base}:state:${config.dryRun ? 'dry' : 'live'}`;
    const processedKey = `qdesk:routing:processed:${config.account}:${identity.conversation}`;
    const pendingKey = `qdesk:routing:pending:${config.account}:${identity.conversation}:${mode}`;
    const owner = randomUUID();
    let locked = false;
    let phase = 'redis';
    try {
      locked = (await redis.set(lockKey, owner, 'EX', LOCK_SECONDS, 'NX')) === 'OK';
      if (!locked) return res.status(503).json({ status: 'busy', retryable: true });
      const pending = await redis.get(pendingKey);
      const storedRecord = await redis.get(processedKey);
      let record;
      try { record = storedRecord ? JSON.parse(storedRecord) : null; } catch { record = null; }
      const recordDecision = routingRecordDecision(req.body, record, rule, now());
      const sameEvaluatedEvent = record?.schema === 1 && record.rule === rule &&
        record.expiresAt > now() && record.eventFingerprint === fingerprint;
      if (!pending && storedRecord && (sameEvaluatedEvent || recordDecision === 'reuse')) {
        if (version(req.body.updated_at) > (version(record.lastEventVersion) || record.version)) {
          if (await redis.get(lockKey) !== owner) throw new Error('lock_lost');
          const remaining = record.expiresAt - now();
          if (remaining <= 0) throw new Error('routing_record_expired');
          await redis.set(processedKey, JSON.stringify({ ...record, lastEventVersion: version(req.body.updated_at) }), 'PX', remaining);
        }
        await count('alreadyProcessed');
        return res.status(200).json({ status: 'already_processed' });
      }
      const duplicate = await redis.get(eventKey);
      // Reentrega idêntica sem novo dado relevante continua deduplicada.
      if (!pending && duplicate && (!storedRecord || recordDecision === 'incomplete_event' || recordDecision === 'uncertain_event')) {
        if (storedRecord) await count('alreadyProcessed');
        return res.status(200).json({ status: 'duplicate' });
      }
      if (storedRecord) {
        if (await redis.get(lockKey) !== owner) throw new Error('lock_lost');
        await redis.del(processedKey);
        await redis.del(stateKey);
        await redis.del(eventKey);
        log({ ...context, decision: 'routing_invalidated', reason: pending ? 'transfer_pending' : recordDecision });
      }

      let cached;
      const stored = await redis.get(stateKey);
      try { cached = stored ? JSON.parse(stored) : null; } catch { cached = null; }
      if (!pending && !storedRecord && canSuppress(req.body, cached, config.source, now())) {
        // Atualiza somente a ordem observada, conservando o prazo original da janela.
        if (version(req.body.updated_at) > (version(cached.lastEventVersion) || cached.version)) {
          const remaining = STATE_WINDOW_MS - (now() - cached.confirmedAt);
          if (remaining <= 0) throw new Error('state_window_expired');
          await redis.set(stateKey, JSON.stringify({ ...cached, lastEventVersion: version(req.body.updated_at) }),
            'PX', remaining);
        }
        // Não marca evento: a supressão não pode persistir além da janela original.
        return res.status(200).json({ status: 'processed', decision: 'recent_confirmed_state' });
      }
      // Remove estado anterior antes de qualquer consulta ou transferência, inclusive em falhas.
      await redis.del(stateKey);

      const api = `${config.url}/api/v1/accounts/${config.account}/conversations/${identity.conversation}`;
      const options = requestOptions(config);
      phase = 'read_conversation';
      const confirmedAt = now();
      let { data: conversation } = await http.get(api, options);
      if (!conversation || positiveId(conversation.id) !== identity.conversation ||
          (conversation.account_id !== undefined && positiveId(conversation.account_id) !== config.account) ||
          (conversation.account?.id !== undefined && positiveId(conversation.account.id) !== config.account)) {
        throw new Error('invalid_conversation_response');
      }
      let team = positiveId(conversation.meta?.team?.id);
      let group = positiveId(conversation.meta?.sender?.company?.group_company?.id);
      const matches = team === config.source && group !== null && group !== config.general;
      let decision = !team || !group ? 'missing_team_or_group' : matches ? 'would_transfer' : 'no_change';
      if (pending) {
        if (team !== config.target || !group) {
          log({ ...context, decision: 'transfer_pending' });
          return res.status(202).json({ status: 'pending', decision: 'transfer_pending' });
        }
        decision = 'transferred';
      } else if (matches && !config.dryRun) {
        phase = 'verify_lock';
        if (await redis.get(lockKey) !== owner) throw new Error('lock_lost');
        phase = 'assign';
        await redis.set(pendingKey, '1');
        if (await redis.get(lockKey) !== owner) throw new Error('lock_lost');
        try {
          await transferConversation(http, api, config.target, options);
        } catch (error) {
          // Rejeição explícita permite corrigir a causa e tentar novamente; timeout/5xx são incertos.
          if ([400, 401, 403, 404, 405, 413, 415, 422, 429].includes(error.response?.status) &&
              await redis.get(lockKey) === owner) await redis.del(pendingKey);
          throw error;
        }
        phase = 'confirm_transfer';
        ({ data: conversation } = await http.get(api, options));
        if (!validConversation(conversation, identity.conversation, config.account)) throw new Error('invalid_confirmation');
        team = positiveId(conversation.meta?.team?.id);
        group = positiveId(conversation.meta?.sender?.company?.group_company?.id);
        if (team !== config.target || !group) {
          log({ ...context, decision: 'transfer_pending' });
          return res.status(202).json({ status: 'pending', decision: 'transfer_pending' });
        }
        decision = 'transferred';
      }
      if (team && group) {
        phase = 'mark_routing';
        if (await redis.get(lockKey) !== owner) throw new Error('lock_lost');
        const expiresAt = now() + ttlSeconds * 1000;
        await redis.set(processedKey, JSON.stringify({ schema: 1, rule, team, group, eventFingerprint: fingerprint,
          version: version(conversation.updated_at),
          lastEventVersion: Math.max(version(conversation.updated_at) || 0, version(req.body.updated_at) || 0), expiresAt }),
        'EX', ttlSeconds);
        if (decision === 'transferred') { await redis.del(pendingKey); await count('transfers'); }
        await count('validated');
      }
      if (team && group && team !== config.source && version(conversation.updated_at) &&
          now() - confirmedAt < STATE_WINDOW_MS) {
        phase = 'cache_state';
        await redis.set(stateKey, JSON.stringify({ team, group, version: version(conversation.updated_at),
          lastEventVersion: Math.max(version(conversation.updated_at), version(req.body.updated_at) || 0), confirmedAt }),
          'PX', STATE_WINDOW_MS);
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
      // Uma falha não pode deixar marcador de sucesso/deduplicação desta tentativa.
      if (locked) {
        try {
          if (await redis.get(lockKey) === owner) {
            await redis.del(processedKey);
            await redis.del(eventKey);
            await redis.del(stateKey);
          }
        } catch { /* Falha Redis já registrada; mantém reserva de transferência. */ }
      }
      try { await count('errors'); } catch { /* Redis indisponível: falha já registrada acima. */ }
      return res.status(503).json({ status: 'retryable_failure' });
    } finally {
      if (locked) {
        try { await redis.eval(RELEASE_LOCK, 1, lockKey, owner); }
        catch {
          log({ ...context, decision: 'lock_release_failed' });
          try { await count('errors'); } catch { /* Redis indisponível. */ }
        }
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


// Distribuição secundária: usa a mesma configuração, token, API e locks do webhook.
const BACKFILL_LOCK_SECONDS = 300;
const MAX_BACKFILL_PAGES = 10;

function requireData(condition, reason) {
  if (!condition) throw new Error(reason);
}

function validConversation(conversation, id, account) {
  return conversation && positiveId(conversation.id) === id &&
    (conversation.account_id === undefined || positiveId(conversation.account_id) === account) &&
    (conversation.account?.id === undefined || positiveId(conversation.account.id) === account);
}

function unassigned(conversation) {
  const meta = conversation.meta;
  if (!meta || typeof meta !== 'object') return false;
  // No Chatwoot, campos de assignee ausentes significam ausência de responsável.
  return meta.assignee == null && meta.assignee_type == null &&
    conversation.assignee_id == null && conversation.assignee_agent_bot_id == null;
}

function candidate(conversation, config) {
  return positiveId(conversation?.id) && validConversation(conversation, positiveId(conversation.id), config.account) &&
    conversation.status === 'open' && unassigned(conversation) &&
    positiveId(conversation.meta.team?.id) === config.source &&
    positiveId(conversation.meta.sender?.company?.group_company?.id) === config.group;
}

function workingNow(team, instant) {
  if (team.working_hours_enabled === false) return true;
  requireData(team.working_hours_enabled === true && typeof team.timezone === 'string' &&
    Array.isArray(team.working_hours), 'invalid_working_hours');
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: team.timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(instant)).map(part => [part.type, part.value]));
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  const hours = team.working_hours.filter(hour => hour.day_of_week === day);
  requireData(hours.length === 1, 'invalid_working_hours');
  const hour = hours[0];
  requireData(typeof hour.closed_all_day === 'boolean' && typeof hour.open_all_day === 'boolean' &&
    !(hour.closed_all_day && hour.open_all_day), 'invalid_working_hours');
  if (hour.closed_all_day) return false;
  if (!hour.open_all_day) {
    for (const [key, limit] of [['open_hour', 23], ['close_hour', 23], ['open_minutes', 59], ['close_minutes', 59]]) {
      requireData(Number.isInteger(hour[key]) && hour[key] >= 0 && hour[key] <= limit, 'invalid_working_hours');
    }
  }
  const start = hour.open_all_day ? 0 : hour.open_hour * 60 + hour.open_minutes;
  const end = hour.open_all_day ? 1440 : hour.close_hour * 60 + hour.close_minutes;
  requireData(end > start, 'invalid_working_hours');
  const minute = Number(parts.hour) * 60 + Number(parts.minute);
  const breakFields = ['break_start_hour', 'break_start_minutes', 'break_end_hour', 'break_end_minutes'];
  if (breakFields.some(key => hour[key] != null)) {
    for (const key of breakFields) {
      const max = key.endsWith('_hour') ? 23 : 59;
      requireData(Number.isInteger(hour[key]) && hour[key] >= 0 && hour[key] <= max, 'invalid_working_hours');
    }
    const breakStart = hour.break_start_hour * 60 + hour.break_start_minutes;
    const breakEnd = hour.break_end_hour * 60 + hour.break_end_minutes;
    requireData(breakEnd > breakStart && breakStart >= start && breakEnd <= end, 'invalid_working_hours');
    if (minute >= breakStart && minute < breakEnd) return false;
  }
  return minute >= start && minute < end;
}

function metricMap(rows, key) {
  requireData(Array.isArray(rows), 'invalid_metrics');
  const result = new Map();
  for (const row of rows) {
    requireData(row && Object.hasOwn(row, key) && (row[key] === null || positiveId(row[key])) &&
      Number.isSafeInteger(row.open) && row.open >= 0 &&
      Number.isSafeInteger(row.unassigned) && row.unassigned >= 0 && row.unassigned <= row.open,
    'invalid_metrics');
    const id = row[key] === null ? null : positiveId(row[key]);
    requireData(!result.has(id), 'duplicate_metrics');
    result.set(id, row);
  }
  return result;
}

function createQdeskBackfill({ redis, env = process.env, http = axios, logger = console, now = Date.now } = {}) {
  // Reutiliza a validação comum, mas o modo do backfill é inteiramente independente do webhook.
  const config = configuration({ ...env, QDESK_DRY_RUN: env.QDESK_BACKFILL_DRY_RUN ?? 'true' });
  const backfill = {
    ...config,
    enabled: env.QDESK_BACKFILL_ENABLED === 'true',
    source: positiveId(env.QDESK_BACKFILL_SOURCE_TEAM_ID ?? 129),
    target: positiveId(env.QDESK_BACKFILL_TARGET_TEAM_ID ?? 151),
    group: positiveId(env.QDESK_BACKFILL_GROUP_ID ?? 175),
    interval: positiveId(env.QDESK_BACKFILL_INTERVAL_SECONDS ?? 60)
  };
  const prefix = `qdesk:${config.account}:backfill:${backfill.target}`;
  const pendingKey = `${prefix}:pending`;
  const lockKey = `${prefix}:lock`;
  const options = requestOptions(config);
  const api = path => `${config.url}/api/v1/accounts/${config.account}${path}`;
  const get = async (url, params) => (await http.get(url, { ...options, ...(params ? { params } : {}) })).data;
  const conversationUrl = id => api(`/conversations/${id}`);
  let timer;

  async function run() {
    if (!backfill.enabled) return { decision: 'disabled' };
    const stats = { eligibleAgents: null, availableCapacity: null, targetUnassigned: null, candidates: null,
      conversation: null, dryRun: config.dryRun };
    const finish = decision => {
      logger.info('[qdesk-backfill]', { ...stats, decision });
      return { ...stats, decision };
    };
    if (!config.enabled || !config.valid || !redis || !backfill.source || !backfill.target ||
        !backfill.group || backfill.source === backfill.target || !backfill.interval ||
        backfill.interval < 10 || backfill.interval > 86400) return finish('unavailable');
    const owner = randomUUID();
    let locked = false;
    let conversationLock;
    let phase = 'redis';
    const owns = async () => {
      requireData(await redis.get(lockKey) === owner, 'lock_lost');
      if (conversationLock) requireData(await redis.get(conversationLock) === owner, 'conversation_lock_lost');
    };
    async function capacity() {
      const team = await get(api(`/teams/${backfill.target}`));
      requireData(positiveId(team?.id) === backfill.target &&
        (team.account_id === undefined || positiveId(team.account_id) === config.account), 'invalid_team');
      requireData(workingNow(team, now()), 'outside_working_hours');
      requireData(team.allow_auto_assign === true && positiveId(team.max_assignment_limit), 'invalid_team_capacity');
      const members = await get(api(`/teams/${backfill.target}/team_members`));
      requireData(Array.isArray(members), 'invalid_members');
      const ids = new Set();
      for (const member of members) {
        requireData(positiveId(member?.id) && !ids.has(positiveId(member.id)) &&
          (member.account_id === undefined || positiveId(member.account_id) === config.account) &&
          typeof member.active === 'boolean' && typeof member.confirmed === 'boolean' &&
          typeof member.allow_auto_assign === 'boolean' &&
          ['online', 'offline', 'busy'].includes(member.availability_status), 'invalid_members');
        ids.add(positiveId(member.id));
      }
      const agents = members.filter(member => member.active && member.confirmed && member.allow_auto_assign &&
        member.availability_status === 'online');
      stats.eligibleAgents = agents.length;
      const reports = `${config.url}/api/v2/accounts/${config.account}/live_reports/grouped_conversation_metrics`;
      const byAgent = metricMap(await get(reports, { group_by: 'assignee_id' }), 'assignee_id');
      const byTeam = metricMap(await get(reports, { group_by: 'team_id' }), 'team_id');
      // O endpoint Chatwoot omite grupos sem conversas abertas; array validado é obrigatório.
      stats.targetUnassigned = byTeam.get(backfill.target)?.unassigned ?? 0;
      stats.availableCapacity = agents.reduce((sum, member) =>
        sum + Math.max(0, Number(team.max_assignment_limit) - (byAgent.get(positiveId(member.id))?.open ?? 0)), 0);
      requireData(stats.targetUnassigned === 0, 'target_queue_not_empty');
      requireData(stats.availableCapacity > 0, 'no_capacity');
    }
    try {
      locked = await redis.set(lockKey, owner, 'EX', BACKFILL_LOCK_SECONDS, 'NX') === 'OK';
      if (!locked) return finish('busy');
      // Reserva persistente: inclusive timeout do POST exige reconciliação antes de novo envio.
      const pending = await redis.get(pendingKey);
      if (pending) {
        phase = 'reconcile';
        const record = JSON.parse(pending);
        requireData(positiveId(record.conversation), 'invalid_pending');
        stats.conversation = record.conversation;
        const conversation = await get(conversationUrl(record.conversation));
        requireData(validConversation(conversation, record.conversation, config.account), 'invalid_conversation_response');
        if (positiveId(conversation.meta?.team?.id) === backfill.target &&
            ((conversation.meta?.assignee_type === 'User' && positiveId(conversation.meta?.assignee?.id)) ||
              conversation.status === 'resolved')) {
          await owns();
          await redis.del(pendingKey);
          return finish('previous_transfer_confirmed');
        }
        return finish('assignment_pending');
      }
      phase = 'capacity';
      await capacity();
      phase = 'list_candidates';
      const all = [];
      const seen = new Set();
      let expectedTotal;
      let complete = false;
      for (let page = 1; page <= MAX_BACKFILL_PAGES; page++) {
        await owns();
        const response = await get(api('/conversations'), {
          status: 'open', team_id: backfill.source, assignee_type: 'unassigned', page
        });
        const rows = response?.data?.payload;
        const total = response?.data?.meta?.unassigned_count;
        requireData(Array.isArray(rows) && Number.isSafeInteger(total) && total >= 0, 'invalid_candidate_list');
        if (expectedTotal === undefined) expectedTotal = total;
        requireData(total === expectedTotal, 'inconsistent_pagination');
        for (const row of rows) {
          const id = positiveId(row?.id);
          requireData(id && !seen.has(id), 'invalid_pagination');
          seen.add(id);
          all.push(row);
        }
        requireData(all.length <= total, 'inconsistent_pagination');
        if (all.length === total) { complete = true; break; }
        requireData(rows.length > 0, 'incomplete_pagination');
      }
      requireData(complete, 'pagination_limit');
      const candidates = [];
      for (const row of all) {
        if (!candidate(row, backfill)) continue;
        const waiting = version(row.waiting_since) || version(row.created_at);
        requireData(waiting, 'missing_waiting_time');
        if (!await redis.get(`qdesk:${config.account}:backfill:moved:${row.id}`)) candidates.push({ row, waiting });
      }
      stats.candidates = candidates.length;
      candidates.sort((a, b) => a.waiting - b.waiting || Number(a.row.id) - Number(b.row.id));
      if (!candidates.length) return finish('no_candidates');
      const selected = candidates[0].row;
      stats.conversation = positiveId(selected.id);
      conversationLock = `qdesk:${config.account}:${stats.conversation}:lock`;
      if (await redis.set(conversationLock, owner, 'EX', BACKFILL_LOCK_SECONDS, 'NX') !== 'OK') {
        conversationLock = null;
        return finish('conversation_busy');
      }
      phase = 'revalidate';
      // Revalida fila, agentes, limites e expediente imediatamente antes de reservar o envio.
      await capacity();
      const current = await get(conversationUrl(stats.conversation));
      requireData(candidate(current, backfill) && positiveId(current.id) === stats.conversation &&
        (version(current.waiting_since) || version(current.created_at)) === candidates[0].waiting, 'candidate_changed');
      await owns();
      if (config.dryRun) return finish('would_transfer');
      requireData(!await redis.get(`qdesk:${config.account}:backfill:moved:${stats.conversation}`), 'already_moved');
      phase = 'reserve';
      requireData(await redis.set(pendingKey, JSON.stringify({ conversation: stats.conversation }), 'NX') === 'OK', 'pending_exists');
      // Sem expiração: não voltar a mover uma conversa que a automação já tentou movimentar.
      await redis.set(`qdesk:${config.account}:backfill:moved:${stats.conversation}`, '1');
      await owns();
      phase = 'assign';
      await transferConversation(http, conversationUrl(stats.conversation), backfill.target, options);
      phase = 'verify_assignment';
      const after = await get(conversationUrl(stats.conversation));
      requireData(validConversation(after, stats.conversation, config.account), 'invalid_conversation_response');
      if (positiveId(after.meta?.team?.id) === backfill.target && after.meta?.assignee_type === 'User' &&
          positiveId(after.meta?.assignee?.id)) {
        await owns();
        await redis.del(pendingKey);
        return finish('transferred_and_assigned');
      }
      return finish('transferred_assignment_pending');
    } catch (error) {
      // Somente motivos internos; nunca mensagem/corpo/headers recebidos da API.
      const reasons = new Set(['outside_working_hours', 'target_queue_not_empty', 'no_capacity', 'candidate_changed']);
      const knownFailures = new Set(['invalid_working_hours', 'invalid_metrics', 'duplicate_metrics', 'invalid_team',
        'invalid_team_capacity', 'invalid_members', 'invalid_pending', 'invalid_conversation_response',
        'invalid_candidate_list', 'invalid_pagination', 'inconsistent_pagination', 'incomplete_pagination',
        'pagination_limit', 'missing_waiting_time', 'already_moved', 'pending_exists', 'lock_lost', 'conversation_lock_lost']);
      const decision = reasons.has(error.message) ? error.message : 'blocked_failure';
      logger.info('[qdesk-backfill]', { ...stats, decision, phase,
        reason: reasons.has(error.message) || knownFailures.has(error.message) ? error.message : 'dependency_failure',
        upstreamStatus: Number.isInteger(error.response?.status) ? error.response.status : null });
      return { ...stats, decision };
    } finally {
      if (conversationLock) {
        try { await redis.eval(RELEASE_LOCK, 1, conversationLock, owner); } catch { /* TTL */ }
      }
      if (locked) {
        try { await redis.eval(RELEASE_LOCK, 1, lockKey, owner); } catch { /* TTL */ }
      }
    }
  }

  function start() {
    if (!backfill.enabled || timer || !backfill.interval || backfill.interval < 10 || backfill.interval > 86400) return;
    timer = setInterval(() => { void run(); }, backfill.interval * 1000);
    timer.unref?.();
  }
  function stop() { clearInterval(timer); timer = null; }
  return { run, start, stop };
}

module.exports = { createQdeskRouter, createQdeskBackfill, positiveId, structure };
