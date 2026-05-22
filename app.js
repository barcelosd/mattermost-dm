require('dotenv').config();

const express = require('express');
const axios = require('axios');
const Redis = require('ioredis');
const { google } = require('googleapis');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
const customParseFormat = require('dayjs/plugin/customParseFormat');

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(customParseFormat);

// ---------------------------------------------------------
// 1. CONFIGURAÇÕES
// ---------------------------------------------------------
const {
  PORT = 3000,
  REDMINE_URL, REDMINE_API_KEY,
  MATTERMOST_URL, MATTERMOST_TOKEN,
  REDIS_URL, REDIS_TTL_DAYS = 90,
  POLLING_ENABLED = 'true', POLLING_INTERVAL_SECONDS = 60, POLLING_LIMIT = 20,
  ALERT_MINUTES_BEFORE = 10, ALERT_EXTRA_MINUTES_BEFORE = 2, ALERT_WINDOW_SECONDS = 180,
  ALERT_FIELD_NAME = 'Horário', ALERT_POLLING_INTERVAL_SECONDS = 60,
  DAILY_SUMMARY_ENABLED = 'true', DAILY_SUMMARY_HOUR = 17, DAILY_SUMMARY_MINUTE = 45,
  IGNORE_STATUSES = 'Rejeitado,Fechado,Resolvido,Impedido pelo Cliente, Arquivada, Aguardando Link,Reagendar,Aguardando',
  GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN, GOOGLE_CALENDAR_ID,
  GOOGLE_MEET_PROJECT_FIELD_NAME = 'Nome Fantasia',
  MEET_STATUS_NAME = 'Aguardando Data'
} = process.env;

const redmineHeaders = { 'X-Redmine-API-Key': REDMINE_API_KEY, 'Content-Type': 'application/json' };
const mattermostHeaders = { Authorization: `Bearer ${MATTERMOST_TOKEN}`, 'Content-Type': 'application/json' };

// ---------------------------------------------------------
// 2. CACHE
// ---------------------------------------------------------
const redis = REDIS_URL ? new Redis(REDIS_URL, { maxRetriesPerRequest: 1, enableReadyCheck: false }) : null;
const memory = { values: new Map(), meetIssues: new Set(), notified: new Set(), alerts: new Set() };

async function redisSet(key, value) {
  const ttl = Number(REDIS_TTL_DAYS) * 86400;
  if (redis) { await redis.set(key, value, 'EX', ttl); return; }
  memory.values.set(key, value);
  setTimeout(() => memory.values.delete(key), ttl * 1000);
}
async function redisGet(key) { return redis ? redis.get(key) : (memory.values.get(key) || null); }
async function redisDel(key) { if (redis) { await redis.del(key); } else { memory.values.delete(key); } }
async function redisSetAdd(key, value) { if (redis) { await redis.sadd(key, value); } else { memory.meetIssues.add(value); } }
async function redisSetRemove(key, value) { if (redis) { await redis.srem(key, value); } else { memory.meetIssues.delete(value); } }
async function redisSetMembers(key) { return redis ? redis.smembers(key) : Array.from(memory.meetIssues); }
async function wasAlreadyNotified(key) { return redis ? (await redis.get(key)) === '1' : memory.notified.has(key); }
async function markAsNotified(key) {
  const ttl = Number(REDIS_TTL_DAYS) * 86400;
  if (redis) { await redis.set(key, '1', 'EX', ttl); } else { memory.notified.add(key); }
}
async function wasAppointmentAlertSent(key) { return redis ? (await redis.get(key)) === '1' : memory.alerts.has(key); }
async function markAppointmentAlertSent(key) {
  const ttl = Number(REDIS_TTL_DAYS) * 86400;
  if (redis) { await redis.set(key, '1', 'EX', ttl); } else { memory.alerts.add(key); }
}

// ---------------------------------------------------------
// 3. UTILITÁRIOS
// ---------------------------------------------------------
function normalizeText(value) { return String(value || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''); }
function isMeetStatus(issue) { return normalizeText(issue?.status?.name) === normalizeText(MEET_STATUS_NAME); }
function shouldIgnoreIssueByStatus(issue) {
  const status = normalizeText(issue?.status?.name || issue?.status || '');
  return String(IGNORE_STATUSES).split(',').map(normalizeText).filter(Boolean).includes(status);
}
function getLastJournal(issue) { return issue?.journals?.length ? issue.journals[issue.journals.length - 1] : null; }
function getEventKey(issue, source, journal) { return `event:${issue.id}:${journal ? journal.id : source}`; }
function getCustomFieldValue(entity, fieldName) {
  const fields = entity?.custom_fields || entity?.custom_field_values || [];
  return fields.find(f => f.name === fieldName || f.custom_field_name === fieldName)?.value || null;
}
function setCustomFieldValue(entity, fieldName, value) {
  const fields = entity?.custom_fields || entity?.custom_field_values || [];
  const field = fields.find(f => f.name === fieldName || f.custom_field_name === fieldName);
  if (field) field.value = value;
}
function getCustomFieldId(issue, fieldName) {
  const fields = issue?.custom_fields || issue?.custom_field_values || [];
  const field = fields.find(f => f.name === fieldName || f.custom_field_name === fieldName);
  return field?.id || field?.custom_field_id || null;
}
function parseAppointmentDateTime(issue) {
  const date = issue.start_date || issue.due_date;
  const timeValue = getCustomFieldValue(issue, ALERT_FIELD_NAME);
  if (!date || !timeValue) return null;
  let parsedTime = dayjs(timeValue, ['HH[h]mm', 'HH:mm', 'HH[h]'], true);
  if (!parsedTime.isValid()) return null;
  const dateTime = dayjs.tz(`${date} ${parsedTime.format('HH:mm')}`, "YYYY-MM-DD HH:mm", "America/Sao_Paulo").toDate();
  return { dateTime, timeLabel: parsedTime.format('HH[h]mm') };
}
function getEstimatedMinutes(issue) {
  const hours = Number(String(issue.estimated_hours || 0).replace(',', '.'));
  return (!hours || Number.isNaN(hours)) ? null : Math.round(hours * 60);
}

// ---------------------------------------------------------
// 4. MATTERMOST E REDMINE (API)
// ---------------------------------------------------------
async function updateRedmineCustomField(issue, fieldName, value) {
  const fieldId = getCustomFieldId(issue, fieldName);
  if (!fieldId) return;
  await axios.put(`${REDMINE_URL}/issues/${issue.id}.json`, { issue: { custom_fields: [{ id: fieldId, value }] } }, { headers: redmineHeaders });
  setCustomFieldValue(issue, fieldName, value);
}
async function getRedmineUser(userId) {
  const response = await axios.get(`${REDMINE_URL}/users/${userId}.json`, { headers: redmineHeaders });
  return response.data.user;
}
async function getRedmineGroup(groupId) {
  try {
    const response = await axios.get(`${REDMINE_URL}/groups/${groupId}.json?include=users`, { headers: redmineHeaders });
    return response.data.group;
  } catch { return null; }
}
function isRedmineUserActive(user) { return user && user.mail && (!user.status || Number(user.status) === 1); }
async function getResponsibleTargets(issue) {
  const assignee = issue.assignee || issue.assigned_to;
  if (!assignee) return [];
  if (typeof assignee.id === 'string' && assignee.id.includes('@')) return [{ email: assignee.id.trim().toLowerCase(), name: assignee.name || assignee.id }];
  try {
    const user = await getRedmineUser(assignee.id);
    if (isRedmineUserActive(user)) return [{ email: user.mail.toLowerCase(), name: `${user.firstname} ${user.lastname}`.trim() }];
  } catch {}
  const group = await getRedmineGroup(assignee.id);
  if (!group?.users?.length) return [];
  const usersPromises = group.users.map(async (groupUser) => {
    try {
      const fullUser = await getRedmineUser(groupUser.id);
      if (isRedmineUserActive(fullUser)) return { email: fullUser.mail.toLowerCase(), name: `${fullUser.firstname} ${fullUser.lastname}`.trim() };
    } catch { return null; }
  });
  return (await Promise.all(usersPromises)).filter(Boolean);
}
async function getMattermostBotUser() {
  const response = await axios.get(`${MATTERMOST_URL}/api/v4/users/me`, { headers: mattermostHeaders });
  return response.data;
}
async function getMattermostUserByEmail(email) {
  const response = await axios.get(`${MATTERMOST_URL}/api/v4/users/email/${encodeURIComponent(email)}`, { headers: mattermostHeaders });
  return response.data;
}
async function createDirectChannel(botUserId, targetUserId) {
  const response = await axios.post(`${MATTERMOST_URL}/api/v4/channels/direct`, [botUserId, targetUserId], { headers: mattermostHeaders });
  return response.data;
}
async function sendMattermostMessage(channelId, message) {
  await axios.post(`${MATTERMOST_URL}/api/v4/posts`, { channel_id: channelId, message }, { headers: mattermostHeaders });
}
async function notifyTargets(targets, message) {
  const botUser = await getMattermostBotUser();
  for (const target of targets) {
    try {
      const mmUser = await getMattermostUserByEmail(target.email);
      if (mmUser.delete_at && mmUser.delete_at > 0) continue;
      const channel = await createDirectChannel(botUser.id, mmUser.id);
      await sendMattermostMessage(channel.id, message);
      console.log(`Mensagem enviada para ${target.email}`);
    } catch (error) {
      console.error(`Erro enviando Mattermost para ${target.email}:`, error.response?.data || error.message);
    }
  }
}

// ---------------------------------------------------------
// 5. GOOGLE CALENDAR E MEET
// ---------------------------------------------------------
function googleCalendarIsConfigured() { return Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && GOOGLE_REFRESH_TOKEN && GOOGLE_CALENDAR_ID); }
function getGoogleCalendarClient() {
  const auth = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);
  auth.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
  return google.calendar({ version: 'v3', auth });
}
async function getMeetProjectName(issue) {
  if (!issue.project?.id) return '';
  try {
    const response = await axios.get(`${REDMINE_URL}/projects/${issue.project.id}.json`, { headers: redmineHeaders });
    const project = response.data.project;
    return getCustomFieldValue(project, GOOGLE_MEET_PROJECT_FIELD_NAME) || project?.parent?.name || project?.name || issue.project?.name || '';
  } catch { return issue.project?.name || ''; }
}
async function findGoogleEventForIssue(calendar, issueId) {
  const response = await calendar.events.list({ calendarId: GOOGLE_CALENDAR_ID, q: `#${issueId}`, maxResults: 10, singleEvents: false, showDeleted: false });
  return response.data.items?.find(event => event.summary?.startsWith(`#${issueId}`)) || null;
}
function extractMeetLink(event) { return event.hangoutLink || event.conferenceData?.entryPoints?.find(e => e.entryPointType === 'video')?.uri || null; }
async function deleteGoogleMeet(issueId) {
  if (!googleCalendarIsConfigured()) return;
  const calendar = getGoogleCalendarClient();
  let eventId = await redisGet(`redmine:meet:event:${issueId}`);
  try {
    if (!eventId) {
      const event = await findGoogleEventForIssue(calendar, issueId);
      eventId = event?.id || null;
    }
    if (!eventId) {
      await redisSetRemove('redmine:meet:issues', String(issueId)); return;
    }
    await calendar.events.delete({ calendarId: GOOGLE_CALENDAR_ID, eventId });
    console.log(`Meet excluído issue #${issueId}.`);
    await redisDel(`redmine:meet:event:${issueId}`);
    await redisDel(`redmine:meet:signature:${issueId}`);
    await redisSetRemove('redmine:meet:issues', String(issueId));
  } catch (error) {
    if (error.response?.status === 404 || error.response?.status === 410) await redisSetRemove('redmine:meet:issues', String(issueId));
  }
}
async function processGoogleMeet(issue) {
  if (!googleCalendarIsConfigured()) return;
  const appointment = parseAppointmentDateTime(issue);
  const estimatedMinutes = getEstimatedMinutes(issue);

  if (!isMeetStatus(issue) || !appointment || !estimatedMinutes) {
    await deleteGoogleMeet(issue.id);
    return;
  }

  const startDate = appointment.dateTime;
  const endDate = new Date(startDate.getTime() + estimatedMinutes * 60000);
  const projectName = await getMeetProjectName(issue);
  const summary = `#${issue.id} - ${projectName} - ${issue.subject} - ${appointment.timeLabel}`;
  const signature = JSON.stringify({ summary, start: startDate.toISOString(), end: endDate.toISOString() });
  
  const signatureKey = `redmine:meet:signature:${issue.id}`;
  const oldSignature = await redisGet(signatureKey);
  const calendar = getGoogleCalendarClient();
  let eventId = await redisGet(`redmine:meet:event:${issue.id}`);
  let event = null;

  if (eventId) {
    try { event = (await calendar.events.get({ calendarId: GOOGLE_CALENDAR_ID, eventId })).data; } catch { eventId = null; }
  }
  if (!eventId) {
    event = await findGoogleEventForIssue(calendar, issue.id);
    eventId = event?.id || null;
  }
  if (eventId && oldSignature === signature) {
    const meetLink = await redisGet(`redmine:meet:link:${issue.id}`);
    if (meetLink && getCustomFieldValue(issue, 'Google Meet') !== meetLink) {
      await updateRedmineCustomField(issue, 'Google Meet', meetLink);
    }
    return;
  }

  const requestBody = {
    summary, description: `Tarefa Redmine: #${issue.id}\n${REDMINE_URL}/issues/${issue.id}`,
    start: { dateTime: startDate.toISOString(), timeZone: 'America/Sao_Paulo' },
    end: { dateTime: endDate.toISOString(), timeZone: 'America/Sao_Paulo' },
    extendedProperties: { private: { redmineIssueId: String(issue.id) } }
  };

  if (eventId) {
    const response = await calendar.events.patch({ calendarId: GOOGLE_CALENDAR_ID, eventId, conferenceDataVersion: 1, requestBody });
    event = response.data;
    console.log(`Meet atualizado issue #${issue.id}`);
  } else {
    const response = await calendar.events.insert({
      calendarId: GOOGLE_CALENDAR_ID, conferenceDataVersion: 1,
      requestBody: { ...requestBody, conferenceData: { createRequest: { requestId: `redmine-${issue.id}-${Date.now()}`, conferenceSolutionKey: { type: 'hangoutsMeet' } } } }
    });
    event = response.data;
    console.log(`Meet criado issue #${issue.id}`);
  }

  const meetLink = extractMeetLink(event);
  if (meetLink) {
    await updateRedmineCustomField(issue, 'Google Meet', meetLink);
    await redisSet(`redmine:meet:link:${issue.id}`, meetLink);
  }
  await redisSet(`redmine:meet:event:${issue.id}`, event.id);
  await redisSetAdd('redmine:meet:issues', String(issue.id));
  await redisSet(signatureKey, signature);
}

// ---------------------------------------------------------
// 6. ALERTAS E REGRAS DE NEGÓCIO
// ---------------------------------------------------------
function buildNotificationMessage(issue, action, source) {
  const meetLink = getCustomFieldValue(issue, 'Google Meet');
  return [
    `### Notificação do Redmine`, ``, `Você recebeu uma notificação da tarefa **#${issue.id}**.`, ``,
    `**Origem:** ${source}`, `**Ação:** ${action}`, `**Projeto:** ${issue.project?.name || ''}`,
    `**Assunto:** ${issue.subject}`, `**Status:** ${issue.status?.name || ''}`,
    meetLink ? `**Google Meet:** ${meetLink}` : null, ``, `[Abrir tarefa no Redmine](${REDMINE_URL}/issues/${issue.id})`
  ].filter(Boolean).join('\n');
}

function buildAppointmentMessage(issue, alertMinutes, timeLabel) {
  const meetLink = getCustomFieldValue(issue, 'Google Meet');
  return [
    `### Lembrete de compromisso`, ``, `Faltam **${alertMinutes} minutos** para o compromisso da tarefa **#${issue.id}**.`, ``,
    `**Projeto:** ${issue.project?.name || ''}`, `**Assunto:** ${issue.subject}`, `**Horário:** ${timeLabel}`,
    meetLink ? `**Google Meet:** ${meetLink}` : null, ``, `[Abrir tarefa no Redmine](${REDMINE_URL}/issues/${issue.id})`
  ].filter(Boolean).join('\n');
}

async function checkAppointmentAlert(issue) {
  if (shouldIgnoreIssueByStatus(issue)) return;
  const appointment = parseAppointmentDateTime(issue);
  if (!appointment) return;

  const alertMinutesList = [Number(ALERT_MINUTES_BEFORE), Number(ALERT_EXTRA_MINUTES_BEFORE)].filter((v, i, a) => v > 0 && a.indexOf(v) === i);
  
  for (const alertMinutes of alertMinutesList) {
    const alertAt = new Date(appointment.dateTime.getTime() - alertMinutes * 60000);
    const diffMs = new Date().getTime() - alertAt.getTime();
    const windowMs = Number(ALERT_WINDOW_SECONDS || 180) * 1000;

    if (diffMs < 0 || diffMs > windowMs) continue;

    const alertKey = `redmine:appointment:${issue.id}:${appointment.dateTime.toISOString()}:${alertMinutes}`;
    if (await wasAppointmentAlertSent(alertKey)) continue;

    const targets = await getResponsibleTargets(issue);
    if (!targets.length) {
      await markAppointmentAlertSent(alertKey); continue;
    }

    const message = buildAppointmentMessage(issue, alertMinutes, appointment.timeLabel);
    await notifyTargets(targets, message);
    console.log(`Alerta de ${alertMinutes} min enviado para issue #${issue.id}.`);
    await markAppointmentAlertSent(alertKey);
  }
}

async function processIssueNotification(issue, action, source, journal = null) {
  if (shouldIgnoreIssueByStatus(issue)) return;
  await processGoogleMeet(issue);
  if (isMeetStatus(issue)) return;
  
  const eventKey = getEventKey(issue, source, journal);
  if (await wasAlreadyNotified(eventKey)) return;

  const targets = await getResponsibleTargets(issue);
  if (!targets.length) return;

  const message = buildNotificationMessage(issue, action, source);
  await notifyTargets(targets, message);
  await markAsNotified(eventKey);
}

// ---------------------------------------------------------
// 7. POLLING
// ---------------------------------------------------------
let lastPollingTimestamp = Date.now() - 10 * 60 * 1000;

async function fetchRecentIssues() {
  const response = await axios.get(`${REDMINE_URL}/issues.json`, {
    headers: redmineHeaders,
    params: { status_id: '*', sort: 'updated_on:desc', limit: Number(POLLING_LIMIT) }
  });
  return response.data.issues || [];
}

async function fetchIssueDetails(issueId) {
  const response = await axios.get(`${REDMINE_URL}/issues/${issueId}.json`, {
    headers: redmineHeaders,
    params: { include: 'journals' }
  });
  return response.data.issue;
}

async function pollingRedmineIssues() {
  console.log(`[${dayjs().format('HH:mm:ss')}] Iniciando Polling no Redmine...`);
  try {
    const issues = await fetchRecentIssues();
    for (const issueSummary of issues) {
      const updatedAt = new Date(issueSummary.updated_on).getTime();
      if (updatedAt < lastPollingTimestamp) continue;
      
      try {
        const issue = await fetchIssueDetails(issueSummary.id);
        const issueWithUrl = { ...issue, url: `${REDMINE_URL}/issues/${issue.id}` };
        
        // AGORA SIM - As funções vitais estão sendo chamadas!
        await processGoogleMeet(issueWithUrl);
        await checkAppointmentAlert(issueWithUrl);

        const lastJournal = getLastJournal(issueWithUrl);
        const eventKey = getEventKey(issueWithUrl, 'Polling', lastJournal);
        
        if (!(await wasAlreadyNotified(eventKey))) {
          await processIssueNotification(issueWithUrl, 'Atualização (via Polling)', 'Polling', lastJournal);
        }
      } catch (errorIssue) {
        console.error(`Erro processando issue #${issueSummary.id}:`, errorIssue.response?.data || errorIssue.message);
      }
    }
    lastPollingTimestamp = Date.now();
  } catch (error) {
    console.error('Erro geral no polling de issues:', error.response?.data || error.message);
  }
}

// ---------------------------------------------------------
// 8. SERVIDOR
// ---------------------------------------------------------
const app = express();

app.get('/polling-now', async (req, res) => {
  await pollingRedmineIssues();
  res.json({ success: true, message: 'Polling engatilhado manualmente.' });
});

app.get('/', (req, res) => {
  res.send('API Bot funcionando via Polling.');
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}. Ciclos de polling ativos.`);
  
  if (String(POLLING_ENABLED) === 'true') {
    setTimeout(pollingRedmineIssues, 5000);
    setInterval(pollingRedmineIssues, Number(POLLING_INTERVAL_SECONDS) * 1000);
  }
});