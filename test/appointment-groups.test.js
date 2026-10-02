const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const dayjs = require('dayjs');
dayjs.extend(require('dayjs/plugin/utc'));
dayjs.extend(require('dayjs/plugin/timezone'));
const source = fs.readFileSync(require.resolve('../app.js'), 'utf8');
function section(start, end) {
  return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
}
function harness({ minutes = 10, failMember = false, groupError = null } = {}) {
  const sent = [];
  const marked = new Set();
  const attention = [];
  const issue = { id: 42, assigned_to: { id: 7 }, subject: 'Reunião' };
  const members = [1, 2];
  const context = vm.createContext({
    console: { log() {}, error() {} }, dayjs, TZ: 'America/Sao_Paulo',
    REDMINE_URL: 'https://redmine.example', redmineHeaders: {},
    describeError: error => error.message,
    axios: { get: async url => {
      if (url.includes('/groups/')) {
        if (groupError) throw Object.assign(new Error('group failure'), { response: { status: groupError } });
        return { data: { group: { users: members.map(id => ({ id })) } } };
      }
      const id = Number(url.match(/users\/(\d+)/)[1]);
      if (failMember && id === 2) throw new Error('member unavailable');
      return { data: { user: { id, mail: ` User${id}@Example.com `, status: 1, firstname: `User ${id}` } } };
    } },
    ALERT_WINDOW_SECONDS: 180, ALERT_MINUTES_BEFORE: 10,
    ALERT_EXTRA_MINUTES_BEFORE: 2, WHATSAPP_ALERT_MINUTES_BEFORE: 1,
    isStrictMeetStatus: () => true,
    parseAppointmentDateTime: () => ({ dateTime: dayjs().add(minutes * 60 - 1, 'second').toISOString(), date: '2026-10-05', timeLabel: '09:00' }),
    wasAppointmentAlertSent: async key => marked.has(key),
    markAppointmentAlertSent: async key => marked.add(key),
    wasAlreadyNotified: async key => marked.has(key),
    markAsNotified: async key => marked.add(key),
    notifyAttention: async (...args) => attention.push(args),
    buildAppointmentMessage: (issue, minutes) => `alert ${minutes}`,
    NOTIFICATION_CHANNELS: [{ name: 'chatwoot', isEnabled: () => true, send: async (targets, message) => { sent.push({ targets, message }); return []; } }],
    isDailySummaryTime: () => true,
    getNextBusinessSummaryDateString: () => '2026-10-05',
    fetchIssuesByDate: async () => [issue], fetchIssueDetails: async () => issue,
    getMeetProjectName: async () => 'Projeto', getCustomFieldValue: () => null,
  });
  vm.runInContext(
    section('async function getRedmineUser(', 'async function getWhatsAppGroupId(') +
    section('async function notifyTargetsOnce(', '// ---------------------------------------------------------\n// MENSAGENS') +
    section('const APPOINTMENT_ALERT_LOOKAHEAD_SECONDS', '// ---------------------------------------------------------\n// GOOGLE CALENDAR') +
    section('let dailySummaryRunning = false;', '// ---------------------------------------------------------\n// RESUMO WHATSAPP CLIENTE'), context);
  return { context, issue, members, sent, marked, attention, setFail: value => { failMember = value; } };
}
for (const minutes of [10, 2]) {
  test(`alerta de ${minutes} minutos avisa todos os membros e não repete entregas`, async () => {
    const h = harness({ minutes });
    await h.context.checkAppointmentAlert(h.issue);
    assert.deepEqual(Array.from(h.sent[0].targets, target => target.email), ['user1@example.com', 'user2@example.com']);
    assert.equal(h.sent[0].message, `alert ${minutes}`);
    await h.context.checkAppointmentAlert(h.issue);
    assert.equal(h.sent.length, 1);
  });
}
test('resumo do próximo dia útil inclui o compromisso para cada membro', async () => {
  const h = harness();
  await h.context.processDailySummary();
  assert.deepEqual(h.sent.map(item => item.targets[0].email), ['user1@example.com', 'user2@example.com']);
  assert.ok(h.sent.every(item => item.message.includes('#42 - Projeto - Reunião')));
  assert.ok(h.marked.has('redmine:summary:mattermost:2026-10-05'));
});
test('falha ao consultar membro mantém resumo pendente e permite nova tentativa', async () => {
  const h = harness({ failMember: true });
  await h.context.processDailySummary();
  assert.equal(h.sent.length, 0);
  assert.equal(h.marked.size, 0);
  assert.equal(h.attention.length, 1);
  h.setFail(false);
  await h.context.processDailySummary();
  assert.equal(h.sent.length, 2);
});
test('falha ao consultar membro mantém alerta pendente', async () => {
  const h = harness({ failMember: true });
  await h.context.checkAppointmentAlert(h.issue);
  assert.equal(h.marked.size, 0);
  assert.equal(h.attention.length, 1);
  h.setFail(false);
  await h.context.checkAppointmentAlert(h.issue);
  assert.equal(h.sent[0].targets.length, 2);
});
test('grupo vazio não é tratado como usuário e destinatários duplicados são removidos', async () => {
  const h = harness();
  h.members.push(1);
  assert.equal((await h.context.getResponsibleTargets(h.issue)).length, 2);
  h.members.length = 0;
  assert.equal((await h.context.getResponsibleTargets(h.issue)).length, 0);
});
test('404 de grupo mantém atribuição individual; 403 não conclui o resumo', async () => {
  const individual = harness({ groupError: 404 });
  assert.equal((await individual.context.getResponsibleTargets(individual.issue))[0].email, 'user7@example.com');
  const denied = harness({ groupError: 403 });
  await denied.context.processDailySummary();
  assert.equal(denied.marked.size, 0);
  assert.equal(denied.attention.length, 1);
});
