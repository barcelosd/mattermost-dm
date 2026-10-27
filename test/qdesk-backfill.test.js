const test = require('node:test');
const assert = require('node:assert/strict');
const { createQdeskBackfill } = require('../integrations/qdesk');

const sample = (id = 42, waiting = 100) => ({ id, account_id: 15, status: 'open', waiting_since: waiting, created_at: 50,
  meta: { team: { id: 129 }, sender: { company: { group_company: { id: 175 } } } } });
function harness({ env = {}, now = () => Date.parse('2026-10-26T15:00:00Z') } = {}) {
  const values = new Map();
  const logs = [];
  const calls = [];
  const state = {
    team: { id: 151, account_id: 15, allow_auto_assign: true, max_assignment_limit: 3,
      working_hours_enabled: true, timezone: 'America/Sao_Paulo', working_hours: [
        { day_of_week: 1, closed_all_day: false, open_all_day: false,
          open_hour: 8, open_minutes: 0, close_hour: 18, close_minutes: 0 }
      ] },
    members: [{ id: 10, active: true, confirmed: true, allow_auto_assign: true, availability_status: 'online' }],
    agents: [{ assignee_id: 10, open: 2, unassigned: 0 }],
    teams: [{ team_id: 151, open: 2, unassigned: 0 }],
    rows: [sample()],
    current: sample(),
    after: { ...sample(), meta: { ...sample().meta, team: { id: 151 }, assignee: { id: 10 }, assignee_type: 'User' } },
    posted: false
  };
  const redis = {
    async get(key) { return values.get(key) ?? null; },
    async set(key, value, ...args) {
      if (args.includes('NX') && values.has(key)) return null;
      values.set(key, value); return 'OK';
    },
    async del(key) { return values.delete(key); },
    async eval(script, count, key, owner) { if (values.get(key) === owner) values.delete(key); }
  };
  const http = {
    async get(url, options) {
      calls.push({ method: 'get', url, options });
      if (url.endsWith('/team_members')) return { data: state.members };
      if (url.endsWith('/teams/151')) return { data: state.team };
      if (url.endsWith('/grouped_conversation_metrics')) return { data: options.params.group_by === 'assignee_id' ? state.agents : state.teams };
      if (url.endsWith('/conversations')) return { data: { data: { payload: state.rows, meta: { unassigned_count: state.rows.length } } } };
      if (/\/conversations\/\d+$/.test(url)) return { data: state.posted ? state.after : state.current };
      throw new Error('unexpected path');
    },
    async post(url, body, options) { calls.push({ method: 'post', url, body, options }); state.posted = true; return { data: {} }; }
  };
  const job = createQdeskBackfill({ redis, http, now, logger: { info: (...args) => logs.push(args) }, env: {
    QDESK_ENABLED: 'true', QDESK_BACKFILL_ENABLED: 'true', QDESK_DRY_RUN: 'false', QDESK_BACKFILL_DRY_RUN: 'false',
    QDESK_API_ACCESS_TOKEN: 'test-api-token', QDESK_WEBHOOK_SECRET: 'test-webhook-secret-of-at-least-32-bytes', ...env
  } });
  return { ...job, state, redis, values, http, calls, logs, posts: () => calls.filter(call => call.method === 'post') };
}

test('backfill desabilitado por padrão não acessa Redis/API', async () => {
  const job = createQdeskBackfill();
  assert.equal((await job.run()).decision, 'disabled');
});

test('fila prioritária pendente bloqueia transferência', async () => {
  const h = harness(); h.state.teams[0].unassigned = 1;
  assert.equal((await h.run()).decision, 'target_queue_not_empty');
  assert.equal(h.posts().length, 0);
});

test('todos no limite bloqueiam transferência', async () => {
  const h = harness(); h.state.agents[0].open = 3;
  assert.equal((await h.run()).decision, 'no_capacity');
  assert.equal(h.posts().length, 0);
});

for (const change of [{ availability_status: 'offline' }, { allow_auto_assign: false }, { active: false }, { confirmed: false }]) {
  test(`agente inelegível não contribui para capacidade: ${JSON.stringify(change)}`, async () => {
    const h = harness(); Object.assign(h.state.members[0], change);
    const result = await h.run();
    assert.equal(result.decision, 'no_capacity');
    assert.equal(result.eligibleAgents, 0);
    assert.equal(h.posts().length, 0);
  });
}

test('capacidade disponível transfere uma única conversa, sem assignee_id, e verifica atribuição', async () => {
  const h = harness();
  const result = await h.run();
  assert.equal(result.decision, 'transferred_and_assigned');
  assert.equal(result.availableCapacity, 1);
  assert.equal(h.posts().length, 1);
  assert.deepEqual(h.posts()[0].body, { team_id: 151 });
  assert.equal(h.posts()[0].options.headers.api_access_token, 'test-api-token');
  assert.match(h.calls.at(-1).url, /conversations\/42$/);
  assert.equal([...h.values.keys()].some(key => key.endsWith(':pending')), false);
  assert.equal(h.values.get('qdesk:15:backfill:moved:42'), '1');
});

for (const kind of ['wrong_group', 'assigned', 'closed', 'wrong_team']) {
  test(`lista filtra conversa ${kind}`, async () => {
    const h = harness();
    if (kind === 'wrong_group') h.state.rows[0].meta.sender.company.group_company.id = 176;
    if (kind === 'assigned') h.state.rows[0].meta.assignee = { id: 10 };
    if (kind === 'closed') h.state.rows[0].status = 'resolved';
    if (kind === 'wrong_team') h.state.rows[0].meta.team.id = 151;
    assert.equal((await h.run()).decision, 'no_candidates');
    assert.equal(h.posts().length, 0);
  });
}

test('ordena por waiting_since usando created_at como alternativa', async () => {
  const h = harness({ env: { QDESK_BACKFILL_DRY_RUN: 'true' } });
  h.state.rows = [sample(42, 200), sample(43, 100), { ...sample(44), waiting_since: null, created_at: 80 }];
  h.state.current = h.state.rows[2];
  assert.equal((await h.run()).conversation, 44);
  assert.equal(h.posts().length, 0);
});

test('conversa que foi atribuída após listagem não é transferida', async () => {
  const h = harness(); h.state.current.meta.assignee = { id: 10 };
  assert.equal((await h.run()).decision, 'candidate_changed');
  assert.equal(h.posts().length, 0);
});

test('duas execuções simultâneas usam bloqueio compartilhado', async () => {
  const h = harness();
  let release; let enter;
  const ready = new Promise(resolve => { enter = resolve; });
  const get = h.http.get;
  let first = true;
  h.http.get = async (...args) => {
    if (first) { first = false; enter(); await new Promise(resolve => { release = resolve; }); }
    return get(...args);
  };
  const running = h.run(); await ready;
  assert.equal((await h.run()).decision, 'busy');
  release(); await running;
  assert.equal(h.posts().length, 1);
});

test('falhas de API e Redis bloqueiam sem vazar credenciais', async () => {
  for (const type of ['api', 'redis']) {
    const h = harness();
    if (type === 'api') h.http.get = async () => { throw new Error('test-api-token'); };
    else h.redis.set = async () => { throw new Error('test-api-token'); };
    assert.equal((await h.run()).decision, 'blocked_failure');
    assert.equal(h.posts().length, 0);
    assert.equal(JSON.stringify(h.logs).includes('test-api-token'), false);
  }
});

test('fora do expediente e timezone inválida bloqueiam', async () => {
  const h = harness({ now: () => Date.parse('2026-10-26T23:00:00Z') });
  assert.equal((await h.run()).decision, 'outside_working_hours');
  const other = harness(); other.state.team.timezone = 'invalid';
  assert.equal((await other.run()).decision, 'blocked_failure');
});

test('dry-run executa consultas e validações sem reserva ou transferência', async () => {
  const h = harness({ env: { QDESK_BACKFILL_DRY_RUN: 'true' } });
  const result = await h.run();
  assert.equal(result.decision, 'would_transfer');
  assert.equal(result.candidates, 1);
  assert.equal(result.conversation, 42);
  assert.equal(h.posts().length, 0);
  assert.equal(h.values.size, 0);
  assert.equal(h.calls.filter(call => call.url.endsWith('/teams/151')).length, 2);
});

test('transferência sem atribuição imediata bloqueia ciclos seguintes até reconciliação', async () => {
  const h = harness(); delete h.state.after.meta.assignee; delete h.state.after.meta.assignee_type;
  assert.equal((await h.run()).decision, 'transferred_assignment_pending');
  assert.equal((await h.run()).decision, 'assignment_pending');
  assert.equal(h.posts().length, 1);
  h.state.after.meta.assignee = { id: 10 }; h.state.after.meta.assignee_type = 'User';
  assert.equal((await h.run()).decision, 'previous_transfer_confirmed');
  assert.equal((await h.run()).decision, 'no_candidates');
  assert.equal(h.posts().length, 1);
});

test('timeout de POST preserva reserva e impede nova tentativa de transferência', async () => {
  const h = harness(); h.http.post = async () => { throw new Error('timeout'); };
  assert.equal((await h.run()).decision, 'blocked_failure');
  assert.equal((await h.run()).decision, 'assignment_pending');
  assert.equal(h.posts().length, 0);
});

for (const mutate of [
  h => { delete h.state.team.max_assignment_limit; },
  h => { delete h.state.team.working_hours_enabled; },
  h => { delete h.state.members[0].active; },
  h => { h.state.teams = {}; },
  h => { h.state.agents[0].open = null; }
]) {
  test('resposta incompleta não permite transferência', async () => {
    const h = harness(); mutate(h);
    assert.equal((await h.run()).decision, 'blocked_failure');
    assert.equal(h.posts().length, 0);
  });
}

test('fila que surge durante seleção bloqueia no segundo exame', async () => {
  const h = harness(); const get = h.http.get; let checks = 0;
  h.http.get = async (url, opts) => {
    if (url.endsWith('/teams/151') && ++checks === 2) h.state.teams[0].unassigned = 1;
    return get(url, opts);
  };
  assert.equal((await h.run()).decision, 'target_queue_not_empty');
  assert.equal(h.posts().length, 0);
});

test('lista paginada deve ser completa antes de escolher mais antiga', async () => {
  const h = harness({ env: { QDESK_BACKFILL_DRY_RUN: 'true' } });
  const get = h.http.get;
  h.state.current = sample(43, 10);
  h.http.get = async (url, options) => {
    if (url.endsWith('/conversations')) return { data: { data: {
      meta: { unassigned_count: 2 }, payload: [options.params.page === 1 ? sample(42, 100) : sample(43, 10)]
    } } };
    return get(url, options);
  };
  assert.equal((await h.run()).conversation, 43);
});

test('lock do webhook impede movimentação simultânea da mesma conversa', async () => {
  const h = harness(); h.values.set('qdesk:15:42:lock', 'webhook-owner');
  assert.equal((await h.run()).decision, 'conversation_busy');
  assert.equal(h.posts().length, 0);
  assert.equal(h.values.get('qdesk:15:42:lock'), 'webhook-owner');
});

for (const [time, expected] of [
  ['11:59', 'would_transfer'], ['12:00', 'outside_working_hours'],
  ['13:29', 'outside_working_hours'], ['13:30', 'would_transfer'],
  ['08:59', 'outside_working_hours'], ['09:00', 'would_transfer'], ['18:00', 'outside_working_hours']
]) {
  test(`expediente real Q-Desk incluindo intervalo: ${time}`, async () => {
    const h = harness({ env: { QDESK_BACKFILL_DRY_RUN: 'true' }, now: () => Date.parse(`2026-10-26T${time}:00-03:00`) });
    Object.assign(h.state.team.working_hours[0], {
      open_hour: 9, break_start_hour: 12, break_start_minutes: 0, break_end_hour: 13, break_end_minutes: 30
    });
    assert.equal((await h.run()).decision, expected);
    assert.equal(h.posts().length, 0);
  });
}

test('dia fechado e intervalo incompleto bloqueiam distribuição', async () => {
  const h = harness();
  h.state.team.working_hours[0].closed_all_day = true;
  assert.equal((await h.run()).decision, 'outside_working_hours');
  const other = harness();
  other.state.team.working_hours[0].break_start_hour = 12;
  assert.equal((await other.run()).decision, 'blocked_failure');
  assert.equal(other.logs.at(-1)[1].reason, 'invalid_working_hours');
});

test('perda do bloqueio antes de POST impede transferência', async () => {
  const h = harness(); const get = h.http.get;
  h.http.get = async (url, options) => {
    const result = await get(url, options);
    if (url.endsWith('/conversations/42')) h.values.delete('qdesk:15:backfill:151:lock');
    return result;
  };
  assert.equal((await h.run()).decision, 'blocked_failure');
  assert.equal(h.posts().length, 0);
});

for (const webhookMode of ['false', 'true', 'invalid']) {
  test(`backfill sem modo configurado simula independentemente do webhook=${webhookMode}`, async () => {
    const h = harness({ env: { QDESK_BACKFILL_DRY_RUN: undefined, QDESK_DRY_RUN: webhookMode } });
    const result = await h.run();
    assert.equal(result.decision, 'would_transfer');
    assert.equal(result.dryRun, true);
    assert.equal(h.posts().length, 0);
    assert.equal(h.values.size, 0);
    assert.equal(h.calls.filter(call => call.url.endsWith('/teams/151')).length, 2);
    assert.equal(h.calls.filter(call => call.url.endsWith('/conversations/42')).length, 1);
    assert.equal(h.calls.filter(call => call.url.endsWith('/grouped_conversation_metrics')).length, 4);
  });
}

test('backfill explicitamente em modo real independe do dry-run do webhook', async () => {
  const h = harness({ env: { QDESK_BACKFILL_DRY_RUN: 'false', QDESK_DRY_RUN: 'true' } });
  assert.equal((await h.run()).decision, 'transferred_and_assigned');
  assert.equal(h.posts().length, 1);
});

for (const invalid of ['', 'TRUE', 'invalid']) {
  test(`modo backfill inválido bloqueia transferências: ${JSON.stringify(invalid)}`, async () => {
    const h = harness({ env: { QDESK_BACKFILL_DRY_RUN: invalid } });
    assert.equal((await h.run()).decision, 'unavailable');
    assert.equal(h.calls.length, 0);
    assert.equal(h.posts().length, 0);
  });
}

test('backfill seleciona conversa mesmo com marcador de roteamento do webhook', async () => {
  const h = harness();
  const marker = JSON.stringify({ team: 129, group: 175 });
  h.values.set('qdesk:routing:processed:15:42', marker);
  assert.equal((await h.run()).decision, 'transferred_and_assigned');
  assert.equal(h.posts().length, 1);
  assert.equal(h.values.get('qdesk:routing:processed:15:42'), marker);
});
