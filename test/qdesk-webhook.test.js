const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createQdeskRouter } = require('../integrations/qdesk');

const secret = 'a-secure-test-secret-of-at-least-32-characters';
const event = { event: 'conversation_updated', id: 42, account: { id: 15 } };
const current = (team = 129, group = 200) => ({
  id: 42, account_id: 15,
  meta: { team: { id: team }, sender: { company: { group_company: { id: group } } } }
});
async function harness(t, { env = {}, conversation = current(), redisMissing = false, now = Date.now } = {}) {
  const values = new Map();
  const expiries = new Map();
  const hashes = new Map();
  const logs = [];
  const calls = [];
  const redis = {
    async set(key, value, ...args) {
      if (args.includes('NX') && values.has(key)) return null;
      values.set(key, value);
      const ex = args.indexOf('EX');
      const px = args.indexOf('PX');
      if (ex >= 0) expiries.set(key, now() + args[ex + 1] * 1000);
      else if (px >= 0) expiries.set(key, now() + args[px + 1]);
      else expiries.delete(key);
      return 'OK';
    },
    async get(key) {
      if (expiries.has(key) && expiries.get(key) <= now()) values.delete(key);
      return values.get(key) ?? null;
    },
    async hincrby(key, field, amount) {
      const hash = hashes.get(key) || {};
      hash[field] = (hash[field] || 0) + amount;
      hashes.set(key, hash); return hash[field];
    },
    async del(key) { return values.delete(key); },
    async eval(script, count, key, owner, ttl) {
      if (script.includes('HINCRBY') || script.includes('HGETALL')) {
        if (expiries.has(key) && expiries.get(key) <= now()) { hashes.delete(key); expiries.delete(key); }
      }
      if (script.includes('HINCRBY')) {
        const value = await redis.hincrby(key, owner, 1);
        if (!expiries.has(key)) expiries.set(key, now() + Number(ttl) * 1000);
        return value;
      }
      if (script.includes('HGETALL')) {
        expiries.delete(key);
        const result = Object.entries(hashes.get(key) || {}).flat(); hashes.delete(key); return result;
      }
      if (values.get(key) === owner) values.delete(key);
    }
  };
  const http = {
    async get(url, options) { calls.push({ method: 'get', url, options }); return { data: conversation }; },
    async post(url, body, options) { calls.push({ method: 'post', url, body, options });
      if (conversation.meta?.team) conversation.meta.team.id = body.team_id;
      return { data: {} }; }
  };
  const app = express();
  const router = createQdeskRouter({
    redis: redisMissing ? null : redis, http, now,
    env: { QDESK_ENABLED: 'true', QDESK_WEBHOOK_SECRET: secret, QDESK_API_ACCESS_TOKEN: 'private-api-token', ...env },
    logger: { info: (...args) => logs.push(args) }
  });
  app.use('/qdesk/webhook', router);
  t.after(() => router.stopRoutingSummary());
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}/qdesk/webhook`;
  async function send(body = event, { token = secret, query = false, raw = false, contentType = 'application/json' } = {}) {
    const response = await fetch(url + (query ? `?secret=${encodeURIComponent(token)}` : ''), {
      method: 'POST', headers: { 'Content-Type': contentType, ...(query ? {} : { Authorization: `Bearer ${token}` }) },
      body: raw ? body : JSON.stringify(body)
    });
    return { status: response.status, body: await response.json() };
  }
  return { send, calls, values, redis, http, logs, conversation, router, hashes, expiries };
}

test('dry-run padrão consulta estado atual e nunca transfere; reentrega é deduplicada', async t => {
  const h = await harness(t);
  assert.equal((await h.send()).body.decision, 'would_transfer');
  assert.equal((await h.send()).body.status, 'already_processed');
  assert.deepEqual(h.calls.map(c => c.method), ['get']);
  assert.equal(h.calls[0].url, 'https://suporte.questor.com.br/api/v1/accounts/15/conversations/42');
});

test('modo real envia somente team_id e usa token no header', async t => {
  const h = await harness(t, { env: { QDESK_DRY_RUN: 'false' } });
  assert.equal((await h.send()).body.decision, 'transferred');
  assert.deepEqual(h.calls.map(c => c.method), ['get', 'post', 'get']);
  assert.equal(h.calls[1].url.endsWith('/42/assignments'), true);
  assert.deepEqual(h.calls[1].body, { team_id: 151 });
  assert.equal(h.calls[1].options.headers.api_access_token, 'private-api-token');
});

for (const [name, team, group] of [
  ['grupo Geral', 129, 175], ['outro time', 151, 200], ['time ausente', null, 200],
  ['grupo ausente', 129, undefined], ['grupo nulo', 129, null], ['grupo inválido', 129, true],
  ['grupo zero', 129, 0]
]) {
  test(`${name} não transfere mesmo com evento elegível`, async t => {
    const c = current(team, group);
    if (group === undefined) delete c.meta.sender.company.group_company.id;
    const h = await harness(t, { env: { QDESK_DRY_RUN: 'false' }, conversation: c });
    await h.send({ ...event, meta: current().meta });
    assert.deepEqual(h.calls.map(c => c.method), ['get']);
  });
}

test('IDs numéricos em string são normalizados', async t => {
  const h = await harness(t, { conversation: current('129', '200') });
  assert.equal((await h.send({ ...event, id: '42', account: { id: '15' } })).body.decision, 'would_transfer');
});

test('autenticação aceita Bearer ou segredo na URL e rejeita segredo incorreto', async t => {
  const h = await harness(t);
  assert.equal((await h.send(event, { token: 'wrong' })).status, 401);
  assert.equal(h.calls.length, 0);
  assert.equal((await h.send(event, { query: true })).status, 200);
});

for (const options of [
  { env: { QDESK_ENABLED: 'false' } }, { redisMissing: true },
  { env: { QDESK_WEBHOOK_SECRET: '' } }, { env: { QDESK_API_ACCESS_TOKEN: '' } },
  { env: { QDESK_URL: 'http://unsafe.example' } }, { env: { QDESK_DRY_RUN: 'typo' } }
]) {
  test(`configuração insegura ou desabilitada impede processamento: ${JSON.stringify(options)}`, async t => {
    const h = await harness(t, options);
    assert.equal((await h.send()).status, 503);
    assert.equal(h.calls.length, 0);
  });
}

test('conta incorreta e formatos desconhecidos não consultam nem transferem; diagnóstico não vaza dados', async t => {
  const h = await harness(t);
  await h.send({ ...event, account: { id: 16 } });
  await h.send({ event: 'message_created', id: 55, content: 'PRIVATE MESSAGE', 'PRIVATE NAME': 'PRIVATE EMAIL', token: secret });
  await h.send({ event: 'conversation_updated', conversation: { id: 42 }, account: { id: 15 } });
  assert.equal(h.calls.length, 0);
  const logs = JSON.stringify(h.logs);
  for (const sensitive of ['PRIVATE', secret, 'private-api-token']) assert.equal(logs.includes(sensitive), false);
  assert.equal(logs.includes('unsupported_event_shape'), true);
});

test('parser rejeita JSON inválido, conteúdo incorreto e corpo grande', async t => {
  const h = await harness(t);
  assert.equal((await h.send('{', { raw: true })).status, 400);
  assert.equal((await h.send(event, { contentType: 'text/plain' })).status, 415);
  assert.equal((await h.send({ data: 'x'.repeat(270000) })).status, 413);
  assert.equal(h.calls.length, 0);
});

test('duas entregas simultâneas são serializadas por conversa', async t => {
  const h = await harness(t, { env: { QDESK_DRY_RUN: 'false' } });
  let release;
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  let reading = true;
  h.http.get = async () => {
    if (reading) { reading = false; entered(); await new Promise(resolve => { release = resolve; }); }
    return { data: h.conversation };
  };
  const first = h.send();
  await ready;
  assert.equal((await h.send()).status, 503);
  release();
  assert.equal((await first).body.decision, 'transferred');
  assert.equal(h.calls.filter(c => c.method === 'post').length, 1);
});

test('falha de API não marca evento; nova tentativa consulta estado antes de repetir', async t => {
  const h = await harness(t, { env: { QDESK_DRY_RUN: 'false' } });
  let attempts = 0;
  h.http.get = async () => ({ data: attempts ? current(151) : current() });
  h.http.post = async () => { attempts++; throw new Error(`private-api-token ${secret}`); };
  assert.equal((await h.send()).status, 503);
  assert.equal((await h.send()).body.decision, 'transferred');
  assert.equal(attempts, 1);
  assert.equal(JSON.stringify(h.logs).includes(secret), false);
});

test('Redis falhando ou bloqueio perdido impede atribuição', async t => {
  const h = await harness(t, { env: { QDESK_DRY_RUN: 'false' } });
  h.redis.set = async () => { throw new Error('redis unavailable'); };
  assert.equal((await h.send()).status, 503);
  assert.equal(h.calls.length, 0);
  const other = await harness(t, { env: { QDESK_DRY_RUN: 'false' } });
  other.http.get = async () => { other.values.clear(); return { data: current() }; };
  assert.equal((await other.send()).status, 503);
  assert.equal(other.calls.length, 0);
});

test('resposta de outra conversa/conta é rejeitada', async t => {
  const h = await harness(t, { conversation: { ...current(), id: 999 } });
  assert.equal((await h.send()).status, 503);
});

test('um novo evento pode reaplicar regra após retorno ao time de origem', async t => {
  const h = await harness(t, { env: { QDESK_DRY_RUN: 'false' } });
  await h.send({ ...event, updated_at: 1 });
  h.conversation.meta.team.id = 129;
  await h.send({ ...event, updated_at: 2, meta: current(129).meta });
  assert.equal(h.calls.filter(c => c.method === 'post').length, 2);
});

for (const eventName of ['conversation_created', 'conversation_updated']) {
  test(`${eventName} sem conta no topo usa contexto autenticado e permanece em dry-run`, async t => {
    const conversation = current();
    delete conversation.account_id;
    const h = await harness(t, { conversation });
    const body = { event: eventName, id: 42, inbox_id: 7, messages: [{ account_id: 999 }] };
    assert.equal((await h.send(body)).body.decision, 'would_transfer');
    assert.equal((await h.send(body)).body.status, 'already_processed');
    assert.deepEqual(h.calls.map(call => call.method), ['get']);
    assert.equal(h.calls[0].url, 'https://suporte.questor.com.br/api/v1/accounts/15/conversations/42');
    assert.equal(h.calls[0].options.headers.api_access_token, 'private-api-token');
  });
}

test('evento sem conta não consulta API sem autenticação válida', async t => {
  const h = await harness(t);
  assert.equal((await h.send({ event: 'conversation_updated', id: 42 }, { token: 'wrong' })).status, 401);
  assert.equal(h.calls.length, 0);
});

for (const explicit of [
  { account_id: 16 }, { account: { id: 16 } },
  { account: { id: 16 }, account_id: 15 }, { account: { id: 15 }, account_id: 16 },
  { account_id: null }, { account: { id: 'invalid' } }
]) {
  test(`conta explícita divergente ou inválida não usa fallback: ${JSON.stringify(explicit)}`, async t => {
    const h = await harness(t);
    assert.equal((await h.send({ event: 'conversation_updated', id: 42, ...explicit })).body.status, 'ignored');
    assert.equal(h.calls.length, 0);
  });
}

for (const response of [{ ...current(), account_id: 16 }, { ...current(), account: { id: 16 } }, { ...current(), id: 99 }]) {
  test(`evento sem conta rejeita resposta de API divergente: ${JSON.stringify({ id: response.id, account_id: response.account_id, account: response.account })}`, async t => {
    const h = await harness(t, { conversation: response, env: { QDESK_DRY_RUN: 'false' } });
    assert.equal((await h.send({ event: 'conversation_updated', id: 42 })).status, 503);
    assert.deepEqual(h.calls.map(call => call.method), ['get']);
    assert.equal([...h.values.keys()].some(key => key.includes(':event:')), false);
  });
}

test('conversa sem acesso pela API não é processada nem marcada', async t => {
  const h = await harness(t);
  h.http.get = async () => { throw Object.assign(new Error('not found'), { response: { status: 404 } }); };
  assert.equal((await h.send({ event: 'conversation_updated', id: 42 })).status, 503);
  assert.equal(h.values.size, 0);
});

for (const [team, group] of [[129, 175], [151, 200], [129, null]]) {
  test(`evento sem conta preserva regra sem transferência: time=${team}, grupo=${group}`, async t => {
    const h = await harness(t, { conversation: current(team, group), env: { QDESK_DRY_RUN: 'false' } });
    assert.equal((await h.send({ event: 'conversation_updated', id: 42 })).status, 200);
    assert.deepEqual(h.calls.map(call => call.method), ['get']);
  });
}

const confirmedOutside = () => ({ ...current(151, 176), updated_at: 100 });
const outsideEvent = (changes = {}) => ({
  event: 'conversation_updated', id: 42, meta: current(151, 176).meta,
  updated_at: 100, changed_attributes: [], ...changes
});

test('serialização estável deduplica objetos e objetos dentro de arrays com chaves reordenadas', async t => {
  const h = await harness(t);
  const first = { ...event, changed_attributes: [{ priority: { current_value: 1, previous_value: 0 } }] };
  const reordered = { changed_attributes: [{ priority: { previous_value: 0, current_value: 1 } }], account: { id: 15 }, id: 42, event: 'conversation_updated' };
  await h.send(first);
  assert.equal((await h.send(reordered)).body.status, 'already_processed');
  assert.equal(h.calls.length, 1);
});

test('estado confirmado suprime eventos equivalentes por 2 segundos sem renovar janela', async t => {
  let clock = 10000;
  const h = await harness(t, { conversation: confirmedOutside(), now: () => clock });
  await h.send(outsideEvent({ messages: [{ id: 1 }] }));
  const key = [...h.values.keys()].find(key => key.includes(':state:'));
  const original = h.values.get(key);
  h.values.delete('qdesk:routing:processed:15:42');
  clock += 1000;
  const second = outsideEvent({ messages: [{ id: 2 }] });
  assert.equal((await h.send(second)).body.decision, 'recent_confirmed_state');
  assert.equal(h.values.get(key), original);
  assert.equal(h.calls.length, 1);
  clock += 999;
  assert.equal((await h.send(second)).body.decision, 'recent_confirmed_state');
  clock += 1;
  assert.equal((await h.send(second)).body.decision, 'no_change');
  assert.equal(h.calls.length, 2);
});

test('nova versão com mudança conhecida irrelevante e consistente reutiliza estado', async t => {
  const h = await harness(t, { conversation: confirmedOutside() });
  await h.send(outsideEvent());
  h.values.delete('qdesk:routing:processed:15:42');
  assert.equal((await h.send(outsideEvent({ updated_at: 101, status: 'open',
    changed_attributes: [{ status: { previous_value: 'pending', current_value: 'open' } }] }))).body.decision,
  'recent_confirmed_state');
  assert.equal(h.calls.length, 1);
});

for (const [name, changes] of [
  ['time 129', { meta: current(129, 176).meta }],
  ['troca de time', { changed_attributes: [{ team_id: { previous_value: 129, current_value: 151 } }] }],
  ['troca de grupo', { changed_attributes: [{ group_company: { previous_value: 175, current_value: 176 } }] }],
  ['grupo diferente', { meta: current(151, 177).meta }],
  ['metadados ausentes', { meta: {} }],
  ['grupo inválido', { meta: current(151, true).meta }],
  ['versão ausente', { updated_at: null }],
  ['versão antiga', { updated_at: 99 }],
  ['nova versão sem alterações', { updated_at: 101 }],
  ['alterações ausentes', { changed_attributes: null }],
  ['alterações inválidas', { changed_attributes: [null] }],
  ['atributo desconhecido', { changed_attributes: [{ custom_attributes: {} }] }],
  ['status contraditório', { status: 'open', changed_attributes: [{ status: { current_value: 'pending', previous_value: 'open' } }] }],
  ['delta incompleto', { status: 'open', changed_attributes: [{ status: { current_value: 'open' } }] }]
]) {
  test(`${name} exige nova consulta mesmo com cache recente`, async t => {
    const h = await harness(t, { conversation: confirmedOutside() });
    await h.send(outsideEvent());
    h.values.delete('qdesk:routing:processed:15:42');
    await h.send(outsideEvent({ marker: 'different', ...changes }));
    assert.equal(h.calls.filter(call => call.method === 'get').length, 2);
  });
}

test('retorno 151 → 129 transfere mesmo dentro da janela e não usa evento atrasado para transferir de novo', async t => {
  const c = confirmedOutside();
  const h = await harness(t, { conversation: c, env: { QDESK_DRY_RUN: 'false' } });
  await h.send(outsideEvent());
  c.meta = current(129, 176).meta;
  c.updated_at = 102;
  assert.equal((await h.send(outsideEvent({ meta: c.meta, updated_at: 102 }))).body.decision, 'transferred');
  c.meta = current(151, 176).meta;
  c.updated_at = 103;
  // Um evento antigo consulta o estado atual; nunca atribui com base no payload antigo.
  await h.send(outsideEvent({ meta: current(129, 176).meta, updated_at: 101 }));
  assert.equal(h.calls.filter(call => call.method === 'post').length, 1);
  assert.equal(h.calls.filter(call => call.method === 'get').length, 4);
});

test('snapshot igual ao confirmado dispensa API mesmo com versão antiga', async t => {
  const c = confirmedOutside();
  const h = await harness(t, { conversation: c, env: { QDESK_DRY_RUN: 'false' } });
  await h.send(outsideEvent());
  c.meta = current(129, 176).meta;
  c.updated_at = 102;
  assert.equal((await h.send(outsideEvent({ updated_at: 99 }))).body.status, 'already_processed');
  assert.equal(h.calls.filter(call => call.method === 'post').length, 0);
});

test('falha de API invalida cache anterior e permite nova tentativa', async t => {
  const h = await harness(t, { conversation: confirmedOutside() });
  await h.send(outsideEvent());
  const get = h.http.get;
  h.http.get = async () => { throw new Error('API unavailable'); };
  assert.equal((await h.send(outsideEvent({ meta: current(129, 176).meta }))).status, 503);
  assert.equal([...h.values.keys()].some(key => key.includes(':state:')), false);
  h.http.get = get;
  assert.equal((await h.send(outsideEvent({ meta: current(129, 176).meta }))).body.decision, 'no_change');
  assert.equal(h.calls.length, 2);
});

test('cache malformado consulta API; falha na leitura Redis não consulta nem transfere', async t => {
  const h = await harness(t, { conversation: confirmedOutside() });
  h.values.set('qdesk:15:42:state:dry', '{');
  await h.send(outsideEvent());
  assert.equal(h.calls.length, 1);
  h.values.delete('qdesk:routing:processed:15:42');
  const get = h.redis.get;
  h.redis.get = async key => { if (key.includes(':state:')) throw new Error('Redis failure'); return get(key); };
  assert.equal((await h.send(outsideEvent({ messages: [2] }))).status, 503);
  assert.equal(h.calls.length, 1);
});

test('falha na gravação do cache não marca evento; repetição tenta novamente', async t => {
  const h = await harness(t, { conversation: confirmedOutside() });
  const set = h.redis.set;
  h.redis.set = async (key, ...args) => { if (key.includes(':state:')) throw new Error('Redis failure'); return set(key, ...args); };
  assert.equal((await h.send(outsideEvent())).status, 503);
  assert.equal([...h.values.keys()].some(key => key.includes(':event:')), false);
  h.redis.set = set;
  assert.equal((await h.send(outsideEvent())).status, 200);
  assert.equal(h.calls.length, 2);
});

test('consulta lenta não cria janela baseada em estado antigo', async t => {
  let clock = 10000;
  const h = await harness(t, { conversation: confirmedOutside(), now: () => clock });
  h.http.get = async () => { clock += 2001; return { data: confirmedOutside() }; };
  await h.send(outsideEvent());
  assert.equal([...h.values.keys()].some(key => key.includes(':state:')), false);
});

test('versão intermediária atrasada consulta API sem estender a janela de supressão', async t => {
  let clock = 10000;
  const h = await harness(t, { conversation: confirmedOutside(), now: () => clock });
  const writes = [];
  const set = h.redis.set;
  h.redis.set = async (key, value, ...args) => {
    if (key.includes(':state:')) writes.push({ value: JSON.parse(value), args });
    return set(key, value, ...args);
  };
  await h.send(outsideEvent());
  h.values.delete('qdesk:routing:processed:15:42');
  clock += 1000;
  const newer = outsideEvent({ updated_at: 102, priority: 1,
    changed_attributes: [{ priority: { previous_value: 0, current_value: 1 } }] });
  assert.equal((await h.send(newer)).body.decision, 'recent_confirmed_state');
  assert.equal(writes[1].value.confirmedAt, 10000);
  assert.deepEqual(writes[1].args, ['PX', 1000]);
  assert.equal((await h.send({ ...newer, updated_at: 101 })).body.decision, 'no_change');
  assert.equal(h.calls.length, 2);
});

test('eventos concorrentes com estado fora da origem mantêm bloqueio; sequência posterior usa cache', async t => {
  const h = await harness(t, { conversation: confirmedOutside() });
  let enter;
  let release;
  const ready = new Promise(resolve => { enter = resolve; });
  const get = h.http.get;
  h.http.get = async (...args) => {
    enter();
    await new Promise(resolve => { release = resolve; });
    return get(...args);
  };
  const first = h.send(outsideEvent());
  await ready;
  const next = outsideEvent({ messages: [2] });
  assert.equal((await h.send(next)).body.status, 'busy');
  release();
  assert.equal((await first).body.decision, 'no_change');
  h.values.delete('qdesk:routing:processed:15:42');
  assert.equal((await h.send(next)).body.decision, 'recent_confirmed_state');
  assert.equal(h.calls.length, 1);
});

test('falha ao invalidar estado Redis impede consulta e transferência', async t => {
  const h = await harness(t, { env: { QDESK_DRY_RUN: 'false' } });
  h.redis.del = async () => { throw new Error('Redis failure'); };
  assert.equal((await h.send()).status, 503);
  assert.equal(h.calls.length, 0);
});

const routingKey = 'qdesk:routing:processed:15:42';
const routingPendingKey = 'qdesk:routing:pending:15:42:live';

test('primeira validação cria marcador por conta/conversa com TTL padrão de 30 dias', async t => {
  const clock = 10000;
  const h = await harness(t, { conversation: confirmedOutside(), now: () => clock });
  assert.equal((await h.send(outsideEvent())).body.decision, 'no_change');
  const marker = JSON.parse(h.values.get(routingKey));
  assert.equal(marker.team, 151);
  assert.equal(marker.group, 176);
  assert.equal(marker.expiresAt, clock + 30 * 86400000);
  assert.equal(h.expiries.get(routingKey), marker.expiresAt);
  assert.equal(h.logs.filter(log => log[1].decision === 'no_change').length, 1);
});

test('atualizações repetidas consultam marcador antes da API e não geram logs individuais', async t => {
  const h = await harness(t, { conversation: confirmedOutside() });
  await h.send(outsideEvent());
  const initialLogs = h.logs.length;
  for (let i = 0; i < 5; i++) {
    const response = await h.send(outsideEvent({ updated_at: 101 + i, messages: [{ id: i }] }));
    assert.equal(response.body.status, 'already_processed');
  }
  assert.equal(h.calls.length, 1);
  assert.equal(h.logs.length, initialLogs);
  await h.router.flushRoutingSummary();
  const summary = h.logs.at(-1);
  assert.equal(summary[0], '[qdesk-routing-summary]');
  assert.deepEqual({ received: summary[1].received, alreadyProcessed: summary[1].alreadyProcessed,
    validated: summary[1].validated, transfers: summary[1].transfers, errors: summary[1].errors },
  { received: 6, alreadyProcessed: 5, validated: 1, transfers: 0, errors: 0 });
  const count = h.logs.length;
  await h.router.flushRoutingSummary();
  assert.equal(h.logs.length, count);
});

test('transferência só é marcada e contada depois de confirmar destino pela API', async t => {
  const c = { ...current(), updated_at: 100 };
  const h = await harness(t, { conversation: c, env: { QDESK_DRY_RUN: 'false' } });
  const body = { ...outsideEvent(), meta: current().meta };
  assert.equal((await h.send(body)).body.decision, 'transferred');
  assert.deepEqual(h.calls.map(call => call.method), ['get', 'post', 'get']);
  assert.equal(JSON.parse(h.values.get(routingKey)).team, 151);
  assert.equal(h.values.has(routingPendingKey), false);
  await h.router.flushRoutingSummary();
  assert.equal(h.logs.at(-1)[1].transfers, 1);
});

test('transferência pendente não marca sucesso, não repete POST e pode ser confirmada depois', async t => {
  const h = await harness(t, { conversation: { ...current(), updated_at: 100 }, env: { QDESK_DRY_RUN: 'false' } });
  h.http.post = async (url, body) => { h.calls.push({ method: 'post', url, body }); return { data: {} }; };
  assert.equal((await h.send(event)).body.decision, 'transfer_pending');
  assert.equal(h.values.has(routingKey), false);
  assert.equal((await h.send(event)).body.decision, 'transfer_pending');
  assert.equal(h.calls.filter(call => call.method === 'post').length, 1);
  h.conversation.meta.team.id = 151;
  assert.equal((await h.send(event)).body.decision, 'transferred');
  assert.equal(h.values.has(routingPendingKey), false);
  assert.equal(h.values.has(routingKey), true);
});

test('erro da transferência não grava marcador nem deduplicação de sucesso', async t => {
  const h = await harness(t, { conversation: { ...current(), updated_at: 100 }, env: { QDESK_DRY_RUN: 'false' } });
  h.http.post = async () => { throw new Error('private-api-token'); };
  assert.equal((await h.send(event)).status, 503);
  assert.equal(h.values.has(routingKey), false);
  assert.equal([...h.values.keys()].some(key => key.includes(':event:')), false);
  assert.equal(h.values.has(routingPendingKey), true);
  assert.equal((await h.send(event)).body.decision, 'transfer_pending');
  assert.equal(JSON.stringify(h.logs).includes('private-api-token'), false);
});

test('dados incompletos e falha de API não marcam processamento', async t => {
  const h = await harness(t, { conversation: current(129, null) });
  assert.equal((await h.send(event)).body.decision, 'missing_team_or_group');
  assert.equal(h.values.has(routingKey), false);
  await h.send(event);
  assert.equal(h.calls.length, 2);
  h.http.get = async () => { throw new Error('API failure'); };
  assert.equal((await h.send(event)).status, 503);
  assert.equal(h.values.has(routingKey), false);
});

test('Redis indisponível ao ler marcador bloqueia transferência e registra falha', async t => {
  const h = await harness(t, { env: { QDESK_DRY_RUN: 'false' } });
  const get = h.redis.get;
  h.redis.get = async key => { if (key === routingKey) throw new Error('Redis failure'); return get(key); };
  assert.equal((await h.send(event)).status, 503);
  assert.equal(h.calls.length, 0);
  assert.equal(h.logs.some(log => log[1].decision === 'failed'), true);
});

test('expiração do TTL configurável revalida conversa e não renova prazo em reentregas', async t => {
  let clock = 10000;
  const h = await harness(t, { conversation: confirmedOutside(), now: () => clock,
    env: { QDESK_ROUTING_PROCESSED_TTL_DAYS: '1' } });
  await h.send(outsideEvent());
  const deadline = h.expiries.get(routingKey);
  clock += 86400000 - 1;
  assert.equal((await h.send(outsideEvent({ updated_at: 101 }))).body.status, 'already_processed');
  assert.equal(h.expiries.get(routingKey), deadline);
  clock += 1;
  assert.equal((await h.send(outsideEvent({ updated_at: 102 }))).body.decision, 'no_change');
  assert.equal(h.calls.length, 2);
});

for (const change of ['team', 'group']) {
  test(`alteração relevante de ${change} invalida marcador e não é escondida pela deduplicação antiga`, async t => {
    const c = { ...current(151, 175), updated_at: 100 };
    const h = await harness(t, { conversation: c, env: { QDESK_DRY_RUN: 'false' } });
    const first = { ...outsideEvent(), meta: structuredClone(c.meta) };
    await h.send(first);
    c.meta.team.id = 129;
    c.meta.sender.company.group_company.id = 176;
    c.updated_at = 101;
    const body = { ...first, meta: structuredClone(c.meta), updated_at: 101,
      changed_attributes: [{ [change === 'team' ? 'team_id' : 'group_company_id']: { previous_value: change === 'team' ? 151 : 175,
        current_value: change === 'team' ? 129 : 176 } }] };
    // Um hash antigo deste evento não pode impedir uma correção necessária.
    const { createHash } = require('node:crypto');
    function stable(value) {
      if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
      if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
      return JSON.stringify(value);
    }
    h.values.set(`qdesk:15:42:event:live:${createHash('sha256').update(stable(body)).digest('hex')}`, '1');
    assert.equal((await h.send(body)).body.decision, 'transferred');
    assert.equal(h.calls.filter(call => call.method === 'post').length, 1);
    assert.equal(h.logs.some(log => log[1].decision === 'routing_invalidated'), true);
  });
}

test('evento atrasado não reutiliza marcação antiga e não transfere com snapshot antigo', async t => {
  const h = await harness(t, { conversation: confirmedOutside(), env: { QDESK_DRY_RUN: 'false' } });
  await h.send(outsideEvent());
  await h.send(outsideEvent({ updated_at: 99, meta: current(129, 176).meta }));
  assert.equal(h.calls.filter(call => call.method === 'get').length, 2);
  assert.equal(h.calls.filter(call => call.method === 'post').length, 0);
});

test('marcação de simulação não dispensa execução real; backfill não controla marcador do webhook', async t => {
  const c = { ...current(), updated_at: 100 };
  const dry = await harness(t, { conversation: c });
  const body = { ...outsideEvent(), meta: structuredClone(c.meta) };
  assert.equal((await dry.send(body)).body.decision, 'would_transfer');
  assert.equal((await dry.send({ ...body, updated_at: 101 })).body.status, 'already_processed');
  assert.equal(dry.calls.filter(call => call.method === 'post').length, 0);
  const live = await harness(t, { conversation: { ...current(), updated_at: 102 }, env: { QDESK_DRY_RUN: 'false' } });
  live.values.set(routingKey, dry.values.get(routingKey));
  live.values.set('qdesk:15:backfill:151:pending', JSON.stringify({ conversation: 42 }));
  assert.equal((await live.send(body)).body.decision, 'transferred');
  assert.equal(live.values.has('qdesk:15:backfill:151:pending'), true);
});

test('falha ao gravar marcador de processamento não deixa sucesso ou evento deduplicado', async t => {
  const h = await harness(t, { conversation: confirmedOutside() });
  const set = h.redis.set;
  h.redis.set = async (key, ...args) => { if (key === routingKey) throw new Error('Redis failure'); return set(key, ...args); };
  assert.equal((await h.send(outsideEvent())).status, 503);
  assert.equal(h.values.has(routingKey), false);
  assert.equal([...h.values.keys()].some(key => key.includes(':event:')), false);
  h.redis.set = set;
  assert.equal((await h.send(outsideEvent())).status, 200);
});

test('concorrência na primeira validação e reentrega usam lock atômico e marcador sem segundo GET', async t => {
  const h = await harness(t, { conversation: confirmedOutside() });
  const get = h.http.get;
  let enter; let release;
  const ready = new Promise(resolve => { enter = resolve; });
  h.http.get = async (...args) => { enter(); await new Promise(resolve => { release = resolve; }); return get(...args); };
  const first = h.send(outsideEvent());
  await ready;
  const next = outsideEvent({ updated_at: 101 });
  assert.equal((await h.send(next)).body.status, 'busy');
  release();
  assert.equal((await first).body.decision, 'no_change');
  assert.equal((await h.send(next)).body.status, 'already_processed');
  assert.equal(h.calls.length, 1);
});

for (const ttl of ['', '0', '-1', '30.5', '3651']) {
  test(`TTL de processamento inválido bloqueia apenas o webhook: ${JSON.stringify(ttl)}`, async t => {
    const h = await harness(t, { env: { QDESK_ROUTING_PROCESSED_TTL_DAYS: ttl } });
    assert.equal((await h.send()).body.status, 'unavailable');
    assert.equal(h.calls.length, 0);
  });
}

test('falha ao incrementar resumo Redis bloqueia antes de transferir e é registrada sem segredo', async t => {
  const h = await harness(t, { env: { QDESK_DRY_RUN: 'false' } });
  h.redis.hincrby = async () => { throw new Error(secret); };
  assert.equal((await h.send()).status, 503);
  assert.equal(h.calls.length, 0);
  assert.equal(h.logs.some(log => log[1].reason === 'redis_failure'), true);
  assert.equal(JSON.stringify(h.logs).includes(secret), false);
});

test('rejeição explícita do POST permite tentar novamente após corrigir a causa', async t => {
  const h = await harness(t, { conversation: { ...current(), updated_at: 100 }, env: { QDESK_DRY_RUN: 'false' } });
  const post = h.http.post;
  h.http.post = async () => { throw Object.assign(new Error('forbidden'), { response: { status: 403 } }); };
  assert.equal((await h.send(event)).status, 503);
  assert.equal(h.values.has(routingKey), false);
  assert.equal(h.values.has(routingPendingKey), false);
  h.http.post = post;
  assert.equal((await h.send(event)).body.decision, 'transferred');
  assert.equal(h.calls.filter(call => call.method === 'post').length, 1);
});

test('contadores têm TTL atômico de cinco minutos sem renovação e expiram sem flush', async t => {
  let clock = 10000;
  const h = await harness(t, { conversation: confirmedOutside(), now: () => clock });
  await h.send(outsideEvent());
  const key = 'qdesk:routing:summary:15:dry';
  assert.equal(h.expiries.get(key), clock + 300000);
  const deadline = h.expiries.get(key);
  clock += 100000;
  await h.send(outsideEvent({ updated_at: 101 }));
  assert.equal(h.expiries.get(key), deadline);
  clock = deadline;
  const logs = h.logs.length;
  await h.router.flushRoutingSummary();
  assert.equal(h.hashes.has(key), false);
  assert.equal(h.logs.length, logs);
});

test('reentrega de mudança relevante já confirmada não invalida nem consulta de novo', async t => {
  const h = await harness(t, { conversation: { ...current(), updated_at: 100 }, env: { QDESK_DRY_RUN: 'false' } });
  const body = { ...outsideEvent(), meta: structuredClone(current().meta),
    changed_attributes: [{ team_id: { previous_value: 150, current_value: 129 } }] };
  assert.equal((await h.send(body)).body.decision, 'transferred');
  const calls = h.calls.length;
  const logs = h.logs.length;
  assert.equal((await h.send(body)).body.status, 'already_processed');
  assert.equal(h.calls.length, calls);
  assert.equal(h.logs.length, logs);
  // Uma mudança posterior continua elegível, mesmo tendo os mesmos time e grupo do primeiro evento.
  h.conversation.meta.team.id = 129;
  h.conversation.updated_at = 101;
  assert.equal((await h.send({ ...body, updated_at: 101 })).body.decision, 'transferred');
  assert.equal(h.calls.filter(call => call.method === 'post').length, 2);
});

test('hash de evento mantém deduplicação independente quando marcador de conversa não existe', async t => {
  const h = await harness(t, { conversation: confirmedOutside() });
  await h.send(outsideEvent());
  h.values.delete(routingKey);
  assert.equal((await h.send(outsideEvent())).body.status, 'duplicate');
  assert.equal(h.calls.length, 1);
});


test('evento completo seguido de vários incompletos preserva marcador e TTL sem logs ou GET', async t => {
  const h = await harness(t, { conversation: confirmedOutside() });
  await h.send(outsideEvent());
  const marker = JSON.parse(h.values.get(routingKey));
  assert.equal(marker.mode, 'dry');
  const deadline = h.expiries.get(routingKey);
  const logs = h.logs.length;
  for (const body of [event, { ...event, meta: {} },
    { ...event, meta: { team: { id: 151 } } },
    { ...event, meta: { sender: {} }, changed_attributes: [null] }]) {
    assert.equal((await h.send(body)).body.status, 'already_processed');
  }
  assert.equal(h.calls.length, 1);
  assert.equal(h.expiries.get(routingKey), deadline);
  assert.equal(h.logs.length, logs);
});

test('evento incompleto é enriquecido pela API; evento completo posterior reutiliza confirmação', async t => {
  const h = await harness(t, { conversation: confirmedOutside() });
  await h.send(event);
  assert.equal((await h.send(outsideEvent())).body.status, 'already_processed');
  assert.equal(h.calls.length, 1);
});

for (const meta of [{ team: null }, { team: { id: null } },
  { sender: { company: null } }, { sender: { company: { group_company: { id: null } } } }, null]) {
  test(`null explícito revalida pela API: ${JSON.stringify(meta)}`, async t => {
    const h = await harness(t, { conversation: confirmedOutside() });
    await h.send(outsideEvent());
    assert.equal((await h.send({ ...event, meta })).body.decision, 'no_change');
    assert.equal(h.calls.length, 2);
    assert.equal(h.logs.some(log => log[1].reason === 'team_or_group_changed'), true);
  });
}

for (const field of ['team_id', 'group_company_id']) {
  test(`evento parcial com delta de ${field} exige reconciliação`, async t => {
    const h = await harness(t, { conversation: confirmedOutside() });
    await h.send(outsideEvent());
    await h.send({ ...event, changed_attributes: [{ [field]: { previous_value: 1, current_value: null } }] });
    assert.equal(h.calls.length, 2);
    assert.equal(h.logs.some(log => log[1].reason === 'explicit_routing_change'), true);
  });
}

test('sem marcador e sem dados na API permanece pendente até enriquecimento', async t => {
  const h = await harness(t, { conversation: current(null, null) });
  for (let i = 0; i < 3; i++) {
    assert.equal((await h.send({ ...event, updated_at: i + 1 })).body.decision, 'missing_team_or_group');
    assert.equal(h.values.has(routingKey), false);
  }
  h.conversation.meta = current(151, 176).meta;
  await h.send(outsideEvent());
  assert.equal(h.values.has(routingKey), true);
});


for (const field of ['team', 'group']) {
  test(`mudança isolada de ${field} atualiza estado confirmado`, async t => {
    const h = await harness(t, { conversation: confirmedOutside() });
    await h.send(outsideEvent());
    if (field === 'team') h.conversation.meta.team.id = 143;
    else h.conversation.meta.sender.company.group_company.id = 175;
    const body = { ...event, meta: structuredClone(h.conversation.meta) };
    assert.equal((await h.send(body)).body.decision, 'no_change');
    const marker = JSON.parse(h.values.get(routingKey));
    assert.equal(marker.team, field === 'team' ? 143 : 151);
    assert.equal(marker.group, field === 'group' ? 175 : 176);
    assert.equal(h.calls.length, 2);
    assert.equal((await h.send({ ...body, updated_at: 200 })).body.status, 'already_processed');
    assert.equal(h.calls.length, 2);
  });
}
