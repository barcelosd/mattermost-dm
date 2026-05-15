require('dotenv').config();

const express = require('express');
const axios = require('axios');
const Redis = require('ioredis');

const app = express();
app.use(express.text({ type: '*/*' }));

const {
  PORT = 3000,
  REDMINE_URL,
  REDMINE_API_KEY,
  MATTERMOST_URL,
  MATTERMOST_TOKEN,
  POLLING_ENABLED = 'true',
  POLLING_INTERVAL_SECONDS = 300,
  POLLING_LIMIT = 20,
  ALERT_MINUTES_BEFORE = 10,
  ALERT_FIELD_NAME = 'Horário',
  ALERT_POLLING_INTERVAL_SECONDS = 60,
  ALERT_TIMEZONE_OFFSET = '-03:00',
  IGNORE_STATUSES = 'Rejeitado,Fechado,Resolvido',
  LOG_SKIPPED_EVENTS = 'false',
  REDIS_URL,
  REDIS_TTL_DAYS = 90
} = process.env;

const redis = REDIS_URL
  ? new Redis(REDIS_URL, {
      maxRetriesPerRequest: 1,
      enableReadyCheck: false,
      lazyConnect: true
    })
  : null;

if (redis) {
  redis.on('connect', () => console.log('Redis conectado.'));
  redis.on('error', err => console.error('Erro Redis:', err.message));

  (async () => {
    try {
      await redis.connect();
      console.log('Redis conectado com sucesso.');
    } catch (err) {
      console.error('Erro ao conectar Redis:', err.message);
    }
  })();
}

const mattermostHeaders = {
  Authorization: `Bearer ${MATTERMOST_TOKEN}`,
  'Content-Type': 'application/json'
};

const redmineHeaders = {
  'X-Redmine-API-Key': REDMINE_API_KEY,
  'Content-Type': 'application/json'
};

const issueAssigneeCache = new Map();
const sentAppointmentAlertsMemory = new Set();
const notifiedEventsMemory = new Set();

let lastPollingTimestamp = Date.now() - 10 * 60 * 1000;

function logSkipped(message) {
  if (LOG_SKIPPED_EVENTS === 'true') {
    console.log(message);
  }
}

function normalizeText(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function getStatusName(issue) {
  if (!issue) return '';
  if (typeof issue.status === 'string') return issue.status;
  return issue.status?.name || '';
}

function shouldIgnoreIssueByStatus(issue) {
  const statusName = getStatusName(issue);

  const ignored = String(IGNORE_STATUSES || '')
    .split(',')
    .map(s => normalizeText(s))
    .filter(Boolean);

  return ignored.includes(normalizeText(statusName));
}

function getBrazilTodayDateString() {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });

  return formatter.format(new Date());
}

function parseBody(rawBody) {
  if (!rawBody) return {};
  if (typeof rawBody !== 'string') return rawBody;

  try {
    return JSON.parse(rawBody);
  } catch {
    const params = new URLSearchParams(rawBody);

    if (params.has('payload')) {
      try {
        return { payload: JSON.parse(params.get('payload')) };
      } catch {
        return {};
      }
    }

    return {};
  }
}

function getPayloadData(body) {
  const data = parseBody(body);

  if (data.payload && typeof data.payload === 'string') {
    try {
      return JSON.parse(data.payload);
    } catch {
      return data;
    }
  }

  if (data.payload && typeof data.payload === 'object') {
    return data.payload;
  }

  return data;
}

function getIssueFromPayload(body) {
  const data = getPayloadData(body);
  console.log('Payload convertido:', JSON.stringify(data, null, 2));
  return data.issue || data.webhook?.issue || null;
}

function getActionFromPayload(body) {
  const data = getPayloadData(body);
  return data.action || null;
}

function getJournalFromPayload(body) {
  const data = getPayloadData(body);
  return data.journal || null;
}

function getLastJournal(issue) {
  if (Array.isArray(issue.journals) && issue.journals.length > 0) {
    return issue.journals[issue.journals.length - 1];
  }

  if (issue.journal) {
    return issue.journal;
  }

  return null;
}

function getAssigneeCacheKey(issue) {
  const assignee = issue.assignee || issue.assigned_to;

  if (!assignee) return 'sem_responsavel';

  return [
    assignee.id || '',
    assignee.mail || '',
    assignee.name || '',
    assignee.lastname || ''
  ].join('|');
}

function getEventKey(issue, source, journalFromPayload = null) {
  const issueId = issue.id;
  const journal = journalFromPayload || getLastJournal(issue);

  if (journal?.id) {
    return `redmine:notified:journal:${issueId}:${journal.id}`;
  }

  if (issue.updated_on) {
    return `redmine:notified:updated:${issueId}:${issue.updated_on}`;
  }

  const assigneeKey = getAssigneeCacheKey(issue);
  return `redmine:notified:fallback:${issueId}:${source}:${assigneeKey}`;
}

function getAppointmentAlertKey(issue, appointmentDate, alertMinutes) {
  return `redmine:appointment:${issue.id}:${appointmentDate.toISOString()}:${alertMinutes}`;
}

async function wasAlreadyNotified(key) {
  if (!key) return false;

  if (redis) {
    const exists = await redis.get(key);
    return exists === '1';
  }

  return notifiedEventsMemory.has(key);
}

async function markAsNotified(key) {
  if (!key) return;

  if (redis) {
    const ttlSeconds = Number(REDIS_TTL_DAYS) * 24 * 60 * 60;
    await redis.set(key, '1', 'EX', ttlSeconds);
    return;
  }

  notifiedEventsMemory.add(key);
}

async function wasAppointmentAlertSent(key) {
  if (!key) return false;

  if (redis) {
    const exists = await redis.get(key);
    return exists === '1';
  }

  return sentAppointmentAlertsMemory.has(key);
}

async function markAppointmentAlertSent(key) {
  if (!key) return;

  if (redis) {
    const ttlSeconds = Number(REDIS_TTL_DAYS) * 24 * 60 * 60;
    await redis.set(key, '1', 'EX', ttlSeconds);
    return;
  }

  sentAppointmentAlertsMemory.add(key);
}

async function getRedmineUser(userId) {
  const response = await axios.get(
    `${REDMINE_URL}/users/${userId}.json`,
    { headers: redmineHeaders }
  );

  return response.data.user;
}

async function getRedmineGroup(groupId) {
  try {
    console.log('Buscando grupo Redmine:', groupId);

    const response = await axios.get(
      `${REDMINE_URL}/groups/${groupId}.json?include=users`,
      { headers: redmineHeaders }
    );

    console.log('Grupo encontrado:', response.data.group?.name);
    console.log('Usuários retornados no grupo:', response.data.group?.users?.length || 0);

    return response.data.group;
  } catch (error) {
    console.error('Erro ao buscar grupo Redmine:');
    console.error(error.response?.status);
    console.error(error.response?.data || error.message);
    return null;
  }
}

async function getMattermostBotUser() {
  const response = await axios.get(
    `${MATTERMOST_URL}/api/v4/users/me`,
    { headers: mattermostHeaders }
  );

  return response.data;
}

async function getMattermostUserByEmail(email) {
  const normalizedEmail = String(email).trim().toLowerCase();

  console.log('Buscando usuário Mattermost pelo e-mail:', normalizedEmail);

  const response = await axios.get(
    `${MATTERMOST_URL}/api/v4/users/email/${encodeURIComponent(normalizedEmail)}`,
    { headers: mattermostHeaders }
  );

  console.log('Usuário Mattermost encontrado:', {
    id: response.data.id,
    username: response.data.username,
    email: response.data.email,
    delete_at: response.data.delete_at
  });

  return response.data;
}

async function createDirectChannel(botUserId, targetUserId) {
  const response = await axios.post(
    `${MATTERMOST_URL}/api/v4/channels/direct`,
    [botUserId, targetUserId],
    { headers: mattermostHeaders }
  );

  return response.data;
}

async function sendMattermostMessage(channelId, message) {
  await axios.post(
    `${MATTERMOST_URL}/api/v4/posts`,
    {
      channel_id: channelId,
      message
    },
    { headers: mattermostHeaders }
  );
}

async function getResponsibleTargets(issue) {
  const assignee = issue.assignee || issue.assigned_to;

  if (!assignee) return [];

  if (assignee.mail) {
    return [{
      type: 'user',
      name: assignee.name || assignee.login || assignee.mail,
      email: assignee.mail.trim().toLowerCase()
    }];
  }

  if (typeof assignee.id === 'string' && assignee.id.includes('@')) {
    return [{
      type: 'user',
      name: assignee.name || assignee.id,
      email: assignee.id.trim().toLowerCase()
    }];
  }

  if (!assignee.id) return [];

  try {
    const user = await getRedmineUser(assignee.id);

    if (user?.mail) {
      return [{
        type: 'user',
        name: `${user.firstname || ''} ${user.lastname || ''}`.trim() || user.login,
        email: user.mail.trim().toLowerCase()
      }];
    }
  } catch (errorUser) {
    console.log('Não localizou como usuário Redmine. Tentando como grupo.');
    console.log(errorUser.response?.status || errorUser.message);
  }

  const group = await getRedmineGroup(assignee.id);

  if (!group) {
    return [{
      type: 'group_error',
      name: assignee.lastname || assignee.name || assignee.id,
      success: false,
      error: 'Grupo não encontrado na API do Redmine.'
    }];
  }

  if (!group.users || group.users.length === 0) {
    return [{
      type: 'group_error',
      name: group.name || assignee.lastname || assignee.id,
      success: false,
      error: 'Grupo encontrado, mas sem usuários retornados pela API.'
    }];
  }

  const targets = [];

  for (const groupUser of group.users) {
    try {
      const fullUser = await getRedmineUser(groupUser.id);

      if (fullUser?.mail) {
        targets.push({
          type: 'group_user',
          groupName: group.name,
          name: `${fullUser.firstname || ''} ${fullUser.lastname || ''}`.trim() || fullUser.login,
          email: fullUser.mail.trim().toLowerCase()
        });
      } else {
        targets.push({
          type: 'group_user_error',
          groupName: group.name,
          name: groupUser.name || groupUser.id,
          success: false,
          error: 'Usuário do grupo não possui e-mail no Redmine.'
        });
      }
    } catch (errorFullUser) {
      targets.push({
        type: 'group_user_error',
        groupName: group.name,
        name: groupUser.name || groupUser.id,
        success: false,
        error: errorFullUser.response?.data || errorFullUser.message
      });
    }
  }

  return targets;
}

function buildMessage(issue, action, source) {
  const issueId = issue.id;
  const subject = issue.subject || 'Sem assunto';
  const status = getStatusName(issue);
  const priority = issue.priority?.name || issue.priority || '';
  const project = issue.project?.name || issue.project || '';
  const url = issue.url || `${REDMINE_URL}/issues/${issueId}`;

  return [
    `### Notificação do Redmine`,
    ``,
    `Você recebeu uma notificação da tarefa **#${issueId}**.`,
    ``,
    `**Origem:** ${source}`,
    `**Ação:** ${action || 'Atualização'}`,
    project ? `**Projeto:** ${project}` : null,
    `**Assunto:** ${subject}`,
    status ? `**Status:** ${status}` : null,
    priority ? `**Prioridade:** ${priority}` : null,
    ``,
    `[Abrir tarefa no Redmine](${url})`
  ].filter(Boolean).join('\n');
}

async function notifyMattermostUser(target, message, botUser) {
  const result = {
    email: target.email,
    name: target.name,
    groupName: target.groupName || null,
    type: target.type,
    success: false,
    stage: null,
    error: null
  };

  try {
    result.stage = 'buscar_usuario_mattermost';

    const mattermostUser = await getMattermostUserByEmail(target.email);

    if (mattermostUser.delete_at && mattermostUser.delete_at > 0) {
      result.stage = 'usuario_mattermost_desativado';
      result.error = 'Usuário Mattermost encontrado, mas está desativado.';
      return result;
    }

    result.stage = 'criar_dm';

    const directChannel = await createDirectChannel(
      botUser.id,
      mattermostUser.id
    );

    result.stage = 'enviar_mensagem';

    await sendMattermostMessage(directChannel.id, message);

    result.success = true;
    result.stage = 'entregue';

    return result;
  } catch (error) {
    result.error = error.response?.data || error.message;

    console.error('Falha ao notificar usuário:');
    console.error(JSON.stringify(result, null, 2));

    return result;
  }
}

async function processIssueNotification(issue, action, source, forceNotify = false, journalFromPayload = null) {
  const issueId = issue.id;
  const status = getStatusName(issue);

  if (shouldIgnoreIssueByStatus(issue)) {
    logSkipped(`Issue #${issueId} ignorada por status: ${status}`);

    return {
      message: `Ignorada por status: ${status}`,
      issue: issueId,
      notified: false
    };
  }

  const eventKey = getEventKey(issue, source, journalFromPayload);

  if (await wasAlreadyNotified(eventKey)) {
    logSkipped(`Evento já notificado. Ignorando: ${eventKey}`);

    return {
      message: 'Evento já notificado anteriormente.',
      issue: issueId,
      eventKey,
      notified: false
    };
  }

  const newAssigneeKey = getAssigneeCacheKey(issue);
  const oldAssigneeKey = issueAssigneeCache.get(issueId);

  if (
    source === 'Polling' &&
    oldAssigneeKey === newAssigneeKey &&
    !forceNotify
  ) {
    logSkipped(`Issue #${issueId} sem mudança de responsável. Não notificado pelo polling.`);

    await markAsNotified(eventKey);

    return {
      message: 'Sem mudança de responsável.',
      issue: issueId,
      eventKey,
      notified: false
    };
  }

  issueAssigneeCache.set(issueId, newAssigneeKey);

  const targets = await getResponsibleTargets(issue);

  if (!targets.length) {
    await markAsNotified(eventKey);

    return {
      message: 'Tarefa sem responsável ou sem e-mail.',
      issue: issueId,
      eventKey,
      notified: false
    };
  }

  const message = buildMessage(issue, action, source);
  const botUser = await getMattermostBotUser();

  const results = [];

  for (const target of targets) {
    if (!target.email) {
      results.push({
        name: target.name,
        groupName: target.groupName || null,
        type: target.type,
        success: false,
        stage: 'sem_email',
        error: target.error || 'Responsável sem e-mail.'
      });

      continue;
    }

    const result = await notifyMattermostUser(target, message, botUser);
    results.push(result);
  }

  console.log('Resultado das notificações:');
  console.log(JSON.stringify(results, null, 2));

  const sent = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);

  if (sent.length > 0) {
    await markAsNotified(eventKey);
  }

  return {
    message: 'Processado.',
    issue: issueId,
    eventKey,
    total: results.length,
    enviados: sent.length,
    falhas: failed.length,
    results
  };
}

function getCustomFieldValue(issue, fieldName) {
  const fields = issue.custom_fields || issue.custom_field_values || [];

  const field = fields.find(f =>
    f.name === fieldName ||
    f.custom_field_name === fieldName
  );

  return field?.value || null;
}

function parseTimeText(timeText) {
  if (!timeText) return null;

  const raw = String(timeText).trim().toLowerCase();

  let match = raw.match(/^(\d{1,2})h(\d{2})$/);

  if (!match) {
    match = raw.match(/^(\d{1,2}):(\d{2})$/);
  }

  if (!match) {
    match = raw.match(/^(\d{1,2})h$/);
  }

  if (!match) return null;

  const hour = Number(match[1]);
  const minute = match[2] ? Number(match[2]) : 0;

  if (hour < 0 || hour > 23) return null;
  if (minute < 0 || minute > 59) return null;

  return {
    hour,
    minute,
    label: `${String(hour).padStart(2, '0')}h${String(minute).padStart(2, '0')}`
  };
}

function parseAppointmentDateTime(issue) {
  const date = issue.start_date || issue.due_date;
  const timeValue = getCustomFieldValue(issue, ALERT_FIELD_NAME);

  if (!date || !timeValue) return null;

  const parsedTime = parseTimeText(timeValue);

  if (!parsedTime) {
    logSkipped(`Horário inválido na issue #${issue.id}: ${timeValue}`);
    return null;
  }

  const dateTime = new Date(
    `${date}T${String(parsedTime.hour).padStart(2, '0')}:${String(parsedTime.minute).padStart(2, '0')}:00${ALERT_TIMEZONE_OFFSET}`
  );

  return {
    dateTime,
    timeLabel: parsedTime.label
  };
}

function buildAppointmentMessage(issue, alertMinutes, timeLabel) {
  const issueId = issue.id;
  const subject = issue.subject || 'Sem assunto';
  const project = issue.project?.name || issue.project || '';
  const url = issue.url || `${REDMINE_URL}/issues/${issueId}`;
  const date = issue.start_date || issue.due_date || '';

  return [
    `### Lembrete de compromisso`,
    ``,
    `Faltam **${alertMinutes} minutos** para o compromisso da tarefa **#${issueId}**.`,
    ``,
    project ? `**Projeto:** ${project}` : null,
    `**Assunto:** ${subject}`,
    date ? `**Data:** ${date}` : null,
    `**Horário:** ${timeLabel}`,
    ``,
    `[Abrir tarefa no Redmine](${url})`
  ].filter(Boolean).join('\n');
}

async function checkAppointmentAlert(issue) {
  if (shouldIgnoreIssueByStatus(issue)) {
    logSkipped(`Alerta da issue #${issue.id} ignorado por status: ${getStatusName(issue)}`);
    return;
  }

  const alertMinutes = Number(ALERT_MINUTES_BEFORE || 10);
  const appointment = parseAppointmentDateTime(issue);

  if (!appointment) return;

  const now = new Date();
  const alertAt = new Date(appointment.dateTime.getTime() - alertMinutes * 60000);

  const diffMs = now.getTime() - alertAt.getTime();
  const alertWindowMs = Number(ALERT_POLLING_INTERVAL_SECONDS) * 1000;

  if (diffMs < 0 || diffMs > alertWindowMs) {
    return;
  }

  const alertKey = getAppointmentAlertKey(issue, appointment.dateTime, alertMinutes);

  if (await wasAppointmentAlertSent(alertKey)) {
    logSkipped(`Alerta da issue #${issue.id} já enviado: ${alertKey}`);
    return;
  }

  console.log(`Enviando alerta de compromisso da issue #${issue.id}.`);

  const targets = await getResponsibleTargets(issue);

  if (!targets.length) {
    console.log(`Issue #${issue.id} sem responsável para alerta.`);
    await markAppointmentAlertSent(alertKey);
    return;
  }

  const message = buildAppointmentMessage(
    issue,
    alertMinutes,
    appointment.timeLabel
  );

  const botUser = await getMattermostBotUser();

  const results = [];

  for (const target of targets) {
    if (!target.email) {
      results.push({
        name: target.name,
        groupName: target.groupName || null,
        type: target.type,
        success: false,
        stage: 'sem_email',
        error: target.error || 'Responsável sem e-mail.'
      });

      continue;
    }

    const result = await notifyMattermostUser(target, message, botUser);
    results.push(result);
  }

  console.log('Resultado dos alertas de compromisso:');
  console.log(JSON.stringify(results, null, 2));

  const sent = results.filter(r => r.success);

  if (sent.length > 0) {
    await markAppointmentAlertSent(alertKey);
  }
}

app.post('/redmine-webhook', async (req, res) => {
  console.log('Webhook recebido.');

  try {
    const issue = getIssueFromPayload(req.body);
    const action = getActionFromPayload(req.body);
    const journal = getJournalFromPayload(req.body);

    if (!issue) {
      return res.status(200).json({
        message: 'Payload recebido, mas sem issue.'
      });
    }

    const result = await processIssueNotification(
      issue,
      action,
      'Webhook',
      true,
      journal
    );

    await checkAppointmentAlert(issue);

    return res.status(200).json(result);
  } catch (error) {
    console.error('Erro geral no webhook:');
    console.error(error.response?.status);
    console.error(error.response?.data || error.message);

    return res.status(500).json({
      message: 'Erro ao processar webhook.',
      error: error.response?.data || error.message
    });
  }
});

async function fetchRecentIssues() {
  const response = await axios.get(
    `${REDMINE_URL}/issues.json`,
    {
      headers: redmineHeaders,
      params: {
        status_id: '*',
        sort: 'updated_on:desc',
        limit: Number(POLLING_LIMIT)
      }
    }
  );

  return response.data.issues || [];
}

async function fetchTodayIssuesForAlerts() {
  const today = getBrazilTodayDateString();

  const response = await axios.get(
    `${REDMINE_URL}/issues.json`,
    {
      headers: redmineHeaders,
      params: {
        status_id: '*',
        limit: 100,
        start_date: today
      }
    }
  );

  return response.data.issues || [];
}

async function fetchIssueDetails(issueId) {
  const response = await axios.get(
    `${REDMINE_URL}/issues/${issueId}.json`,
    {
      headers: redmineHeaders,
      params: {
        include: 'journals'
      }
    }
  );

  return response.data.issue;
}

async function pollingRedmineIssues() {
  console.log('Polling Redmine iniciado.');

  const currentPollingTimestamp = Date.now();

  try {
    const issues = await fetchRecentIssues();

    const changedIssues = issues.filter(issueSummary => {
      const updatedAt = new Date(issueSummary.updated_on).getTime();
      return updatedAt >= lastPollingTimestamp;
    });

    console.log(`Polling encontrou ${changedIssues.length} tarefas alteradas.`);

    if (!changedIssues.length) {
      lastPollingTimestamp = currentPollingTimestamp;
      return;
    }

    for (const issueSummary of changedIssues) {
      try {
        if (shouldIgnoreIssueByStatus(issueSummary)) {
          logSkipped(`Issue #${issueSummary.id} ignorada por status no resumo: ${getStatusName(issueSummary)}`);
          continue;
        }

        const issue = await fetchIssueDetails(issueSummary.id);

        if (shouldIgnoreIssueByStatus(issue)) {
          logSkipped(`Issue #${issue.id} ignorada por status: ${getStatusName(issue)}`);
          continue;
        }

        const issueWithUrl = {
          ...issue,
          url: `${REDMINE_URL}/issues/${issue.id}`
        };

        const lastJournal = getLastJournal(issueWithUrl);

        await processIssueNotification(
          issueWithUrl,
          'Responsável alterado ou verificação periódica',
          'Polling',
          false,
          lastJournal
        );
      } catch (errorIssue) {
        console.error(`Erro no polling da issue #${issueSummary.id}:`);
        console.error(errorIssue.response?.data || errorIssue.message);
      }
    }

    lastPollingTimestamp = currentPollingTimestamp;
  } catch (error) {
    console.error('Erro geral no polling Redmine:');
    console.error(error.response?.status);
    console.error(error.response?.data || error.message);
  }
}

async function pollingAppointmentAlerts() {
  console.log('Polling de alertas iniciado.');

  try {
    const issues = await fetchTodayIssuesForAlerts();

    console.log(`Alertas verificando ${issues.length} tarefas de hoje.`);

    for (const issueSummary of issues) {
      try {
        if (shouldIgnoreIssueByStatus(issueSummary)) {
          continue;
        }

        const issue = await fetchIssueDetails(issueSummary.id);

        const issueWithUrl = {
          ...issue,
          url: `${REDMINE_URL}/issues/${issue.id}`
        };

        await checkAppointmentAlert(issueWithUrl);
      } catch (errorIssue) {
        console.error(`Erro alerta issue #${issueSummary.id}:`);
        console.error(errorIssue.response?.data || errorIssue.message);
      }
    }
  } catch (error) {
    console.error('Erro geral no polling de alertas:');
    console.error(error.response?.status);
    console.error(error.response?.data || error.message);
  }
}

app.get('/polling-now', async (req, res) => {
  await pollingRedmineIssues();
  await pollingAppointmentAlerts();

  res.json({
    message: 'Polling executado manualmente.'
  });
});

app.get('/', (req, res) => {
  res.send('API Redmine → Mattermost funcionando.');
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);

  if (POLLING_ENABLED === 'true') {
    const pollingIntervalMs = Number(POLLING_INTERVAL_SECONDS) * 1000;
    const alertPollingIntervalMs = Number(ALERT_POLLING_INTERVAL_SECONDS) * 1000;

    console.log(`Polling habilitado a cada ${POLLING_INTERVAL_SECONDS} segundos.`);
    console.log(`Polling limit: ${POLLING_LIMIT}`);
    console.log(`Polling de alertas a cada ${ALERT_POLLING_INTERVAL_SECONDS} segundos.`);
    console.log(`Alerta de compromisso habilitado: ${ALERT_MINUTES_BEFORE} minutos antes.`);
    console.log(`Campo de horário: ${ALERT_FIELD_NAME}`);
    console.log(`Timezone offset dos alertas: ${ALERT_TIMEZONE_OFFSET}`);
    console.log(`Status ignorados: ${IGNORE_STATUSES}`);
    console.log(redis ? 'Controle de duplicidade persistente: Redis habilitado.' : 'Controle de duplicidade persistente: Redis não configurado.');

    setTimeout(() => {
      pollingRedmineIssues();
      pollingAppointmentAlerts();
    }, 10000);

    setInterval(pollingRedmineIssues, pollingIntervalMs);
    setInterval(pollingAppointmentAlerts, alertPollingIntervalMs);
  }
});