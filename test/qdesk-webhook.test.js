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
async function harness(t, { env = {}, conversation = current(), redisMissing = false } = {}) {
  const values = new Map();
  const logs = [];
  const calls = [];
  const redis = {
    async set(key, value, ...args) {
      if (args.includes('NX') && values.has(key)) return null;
      values.set(key, value);
      return 'OK';
    },
    async get(key) { return values.get(key) ?? null; },
    async eval(script, count, key, owner) {
      if (values.get(key) === owner) values.delete(key);
    }
  };
  const http = {
    async get(url, options) { calls.push({ method: 'get', url, options }); return { data: conversation }; },
    async post(url, body, options) { calls.push({ method: 'post', url, body, options }); return { data: {} }; }
  };
  const app = express();
  app.use('/qdesk/webhook', createQdeskRouter({
    redis: redisMissing ? null : redis, http,
    env: { QDESK_ENABLED: 'true', QDESK_WEBHOOK_SECRET: secret, QDESK_API_ACCESS_TOKEN: 'private-api-token', ...env },
    logger: { info: (...args) => logs.push(args) }
  }));
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
  return { send, calls, values, redis, http, logs };
}

test('dry-run padrão consulta estado atual e nunca transfere; reentrega é deduplicada', async t => {
  const h = await harness(t);
  assert.equal((await h.send()).body.decision, 'would_transfer');
  assert.equal((await h.send()).body.status, 'duplicate');
  assert.deepEqual(h.calls.map(c => c.method), ['get']);
  assert.equal(h.calls[0].url, 'https://suporte.questor.com.br/api/v1/accounts/15/conversations/42');
});

test('modo real envia somente team_id e usa token no header', async t => {
  const h = await harness(t, { env: { QDESK_DRY_RUN: 'false' } });
  assert.equal((await h.send()).body.decision, 'transferred');
  assert.deepEqual(h.calls.map(c => c.method), ['get', 'post']);
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
  h.http.get = async () => { entered(); await new Promise(resolve => { release = resolve; }); return { data: current() }; };
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
  assert.equal((await h.send()).body.decision, 'no_change');
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
  await h.send({ ...event, updated_at: 2 });
  assert.equal(h.calls.filter(c => c.method === 'post').length, 2);
});

for (const eventName of ['conversation_created', 'conversation_updated']) {
  test(`${eventName} sem conta no topo usa contexto autenticado e permanece em dry-run`, async t => {
    const conversation = current();
    delete conversation.account_id;
    const h = await harness(t, { conversation });
    const body = { event: eventName, id: 42, inbox_id: 7, messages: [{ account_id: 999 }] };
    assert.equal((await h.send(body)).body.decision, 'would_transfer');
    assert.equal((await h.send(body)).body.status, 'duplicate');
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
