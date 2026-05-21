require('dotenv').config();

const express = require('express');
const axios = require('axios');
const Redis = require('ioredis');
const { google } = require('googleapis');

const app = express();
app.use(express.text({ type: '*/*' }));

const {
  PORT = 3000,

  REDMINE_URL,
  REDMINE_API_KEY,

  MATTERMOST_URL,
  MATTERMOST_TOKEN,

  REDIS_URL,
  REDIS_TTL_DAYS = 90,

  POLLING_ENABLED = 'true',
  POLLING_INTERVAL_SECONDS = 300,
  POLLING_LIMIT = 20,

  ALERT_MINUTES_BEFORE = 10,
  ALERT_EXTRA_MINUTES_BEFORE = 2,
  ALERT_FIELD_NAME = 'Horário',
  ALERT_POLLING_INTERVAL_SECONDS = 60,
  ALERT_TIMEZONE_OFFSET = '-03:00',

  DAILY_SUMMARY_ENABLED = 'true',
  DAILY_SUMMARY_HOUR = 17,
  DAILY_SUMMARY_MINUTE = 45,

  IGNORE_STATUSES = 'Rejeitado,Fechado,Resolvido',

  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REFRESH_TOKEN,
  GOOGLE_CALENDAR_ID,

  GOOGLE_MEET_FIELD_NAME = 'Google Meet',
  GOOGLE_MEET_STATUS_NAME = 'Aguardando Data',
  GOOGLE_MEET_PROJECT_FIELD_NAME = 'Nome Fantasia'
} = process.env;

const redis = REDIS_URL
  ? new Redis(REDIS_URL, {
      maxRetriesPerRequest: 1,
      enableReadyCheck: false
    })
  : null;

const mattermostHeaders = {
  Authorization: `Bearer ${MATTERMOST_TOKEN}`,
  'Content-Type': 'application/json'
};

const redmineHeaders = {
  'X-Redmine-API-Key': REDMINE_API_KEY,
  'Content-Type': 'application/json'
};

const notifiedMemory = new Set();
const appointmentAlertMemory = new Set();
const genericMemory = new Map();

let lastPollingTimestamp = Date.now() - 10 * 60 * 1000;

function normalizeText(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function shouldIgnoreIssueByStatus(issue) {
  const status = issue?.status?.name || issue?.status || '';

  const ignored = String(IGNORE_STATUSES)
    .split(',')
    .map(s => normalizeText(s))
    .filter(Boolean);

  return ignored.includes(normalizeText(status));
}

function getPayloadData(body) {
  if (!body) return {};

  try {
    const parsed = JSON.parse(body);

    if (parsed.payload) {
      if (typeof parsed.payload === 'string') {
        return JSON.parse(parsed.payload);
      }

      return parsed.payload;
    }

    return parsed;
  } catch {
    return {};
  }
}

function getCustomFieldValue(entity, fieldName) {
  const fields = entity?.custom_fields || entity?.custom_field_values || [];

  const field = fields.find(f =>
    f.name === fieldName ||
    f.custom_field_name === fieldName
  );

  return field?.value || null;
}

function setCustomFieldValue(entity, fieldName, value) {
  const fields = entity?.custom_fields || entity?.custom_field_values || [];

  const field = fields.find(f =>
    f.name === fieldName ||
    f.custom_field_name === fieldName
  );

  if (field) {
    field.value = value;
  }
}

function getCustomFieldId(issue, fieldName) {
  const fields = issue?.custom_fields || issue?.custom_field_values || [];

  const field = fields.find(f =>
    f.name === fieldName ||
    f.custom_field_name === fieldName
  );

  return field?.id || field?.custom_field_id || null;
}

async function updateRedmineCustomField(issue, fieldName, value) {
  const fieldId = getCustomFieldId(issue, fieldName);

  if (!fieldId) {
    console.log(`Campo não encontrado na tarefa #${issue.id}: ${fieldName}`);
    return;
  }

  await axios.put(
    `${REDMINE_URL}/issues/${issue.id}.json`,
    {
      issue: {
        custom_fields: [
          {
            id: fieldId,
            value
          }
        ]
      }
    },
    { headers: redmineHeaders }
  );

  setCustomFieldValue(issue, fieldName, value);

  console.log(`Campo "${fieldName}" atualizado na tarefa #${issue.id}.`);
}

async function redisGet(key) {
  if (redis) return await redis.get(key);
  return genericMemory.get(key) || null;
}

async function redisSet(key, value) {
  if (redis) {
    const ttl = Number(REDIS_TTL_DAYS) * 24 * 60 * 60;
    await redis.set(key, value, 'EX', ttl);
    return;
  }

  genericMemory.set(key, value);
}

async function wasAlreadyNotified(key) {
  if (!key) return false;

  if (redis) {
    const exists = await redis.get(key);
    return exists === '1';
  }

  return notifiedMemory.has(key);
}

async function markAsNotified(key) {
  if (!key) return;

  if (redis) {
    const ttl = Number(REDIS_TTL_DAYS) * 24 * 60 * 60;
    await redis.set(key, '1', 'EX', ttl);
    return;
  }

  notifiedMemory.add(key);
}

async function wasAppointmentAlertSent(key) {
  if (!key) return false;

  if (redis) {
    const exists = await redis.get(key);
    return exists === '1';
  }

  return appointmentAlertMemory.has(key);
}

async function markAppointmentAlertSent(key) {
  if (!key) return;

  if (redis) {
    const ttl = Number(REDIS_TTL_DAYS) * 24 * 60 * 60;
    await redis.set(key, '1', 'EX', ttl);
    return;
  }

  appointmentAlertMemory.add(key);
}

function getLastJournal(issue) {
  if (Array.isArray(issue.journals) && issue.journals.length > 0) {
    return issue.journals[issue.journals.length - 1];
  }

  return null;
}

function getEventKey(issue, source, journal = null) {
  if (journal?.id) {
    return `redmine:event:${issue.id}:journal:${journal.id}`;
  }

  if (issue.updated_on) {
    return `redmine:event:${issue.id}:updated:${issue.updated_on}`;
  }

  return `redmine:event:${issue.id}:fallback:${source}`;
}

async function getMattermostBotUser() {
  const response = await axios.get(
    `${MATTERMOST_URL}/api/v4/users/me`,
    { headers: mattermostHeaders }
  );

  return response.data;
}

async function getMattermostUserByEmail(email) {
  const response = await axios.get(
    `${MATTERMOST_URL}/api/v4/users/email/${encodeURIComponent(email)}`,
    { headers: mattermostHeaders }
  );

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

async function getRedmineUser(userId) {
  const response = await axios.get(
    `${REDMINE_URL}/users/${userId}.json`,
    { headers: redmineHeaders }
  );

  return response.data.user;
}

async function getRedmineGroup(groupId) {
  try {
    const response = await axios.get(
      `${REDMINE_URL}/groups/${groupId}.json?include=users`,
      { headers: redmineHeaders }
    );

    return response.data.group;
  } catch {
    return null;
  }
}

async function getResponsibleTargets(issue) {
  const assignee = issue.assignee || issue.assigned_to;

  if (!assignee) return [];

  if (typeof assignee.id === 'string' && assignee.id.includes('@')) {
    return [{
      email: assignee.id.trim().toLowerCase(),
      name: assignee.name || assignee.id
    }];
  }

  try {
    const user = await getRedmineUser(assignee.id);

    if (user?.mail) {
      return [{
        email: user.mail.trim().toLowerCase(),
        name: `${user.firstname || ''} ${user.lastname || ''}`.trim()
      }];
    }
  } catch {}

  const group = await getRedmineGroup(assignee.id);

  if (!group?.users?.length) {
    return [];
  }

  const users = [];

  for (const groupUser of group.users) {
    try {
      const fullUser = await getRedmineUser(groupUser.id);

      if (fullUser?.mail) {
        users.push({
          email: fullUser.mail.trim().toLowerCase(),
          name: `${fullUser.firstname || ''} ${fullUser.lastname || ''}`.trim()
        });
      }
    } catch {}
  }

  return users;
}

async function notifyTargets(targets, message) {
  const botUser = await getMattermostBotUser();

  for (const target of targets) {
    try {
      const mmUser = await getMattermostUserByEmail(target.email);

      const channel = await createDirectChannel(
        botUser.id,
        mmUser.id
      );

      await sendMattermostMessage(channel.id, message);

      console.log(`Mensagem enviada para ${target.email}`);

    } catch (error) {
      console.error(
        `Erro enviando para ${target.email}:`,
        error.response?.data || error.message
      );
    }
  }
}

function googleCalendarIsConfigured() {
  return Boolean(
    GOOGLE_CLIENT_ID &&
    GOOGLE_CLIENT_SECRET &&
    GOOGLE_REFRESH_TOKEN &&
    GOOGLE_CALENDAR_ID
  );
}

function getGoogleCalendarClient() {
  const auth = new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET
  );

  auth.setCredentials({
    refresh_token: GOOGLE_REFRESH_TOKEN
  });

  return google.calendar({
    version: 'v3',
    auth
  });
}

async function getRedmineProject(projectId) {
  try {
    const response = await axios.get(
      `${REDMINE_URL}/projects/${projectId}.json`,
      { headers: redmineHeaders }
    );

    return response.data.project;
  } catch {
    return null;
  }
}

async function getMeetProjectName(issue) {
  const project = await getRedmineProject(issue.project?.id);

  const nomeFantasia = getCustomFieldValue(
    project,
    GOOGLE_MEET_PROJECT_FIELD_NAME
  );

  if (nomeFantasia) {
    return nomeFantasia;
  }

  return (
    project?.parent?.name ||
    project?.name ||
    issue.project?.name ||
    ''
  );
}

function parseTimeText(timeText) {
  if (!timeText) return null;

  const raw = String(timeText)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '');

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

function parseTimezoneOffsetToMinutes(offset) {
  const match = String(offset || '-03:00').match(/^([+-])(\d{2}):(\d{2})$/);

  if (!match) return -180;

  const sign = match[1] === '+' ? 1 : -1;
  const hours = Number(match[2]);
  const minutes = Number(match[3]);

  return sign * ((hours * 60) + minutes);
}

function createDateFromRedmineDateTime(date, time) {
  const [year, month, day] = String(date).split('-').map(Number);
  const offsetMinutes = parseTimezoneOffsetToMinutes(ALERT_TIMEZONE_OFFSET);

  const utcMs = Date.UTC(
    year,
    month - 1,
    day,
    time.hour,
    time.minute,
    0,
    0
  ) - (offsetMinutes * 60 * 1000);

  return new Date(utcMs);
}

function getGoogleDateTimeObject(date) {
  return {
    dateTime: date.toISOString(),
    timeZone: 'America/Sao_Paulo'
  };
}

function parseAppointmentDateTime(issue) {
  const date = issue.start_date || issue.due_date;

  const timeValue = getCustomFieldValue(
    issue,
    ALERT_FIELD_NAME
  );

  if (!date || !timeValue) {
    return null;
  }

  const parsed = parseTimeText(timeValue);

  if (!parsed) {
    return null;
  }

  const dateTime = createDateFromRedmineDateTime(date, parsed);

  if (Number.isNaN(dateTime.getTime())) {
    return null;
  }

  return {
    dateTime,
    timeLabel: parsed.label
  };
}

function getEstimatedMinutes(issue) {
  const hours = Number(
    String(issue.estimated_hours || 0).replace(',', '.')
  );

  if (!hours || Number.isNaN(hours)) {
    return null;
  }

  return Math.round(hours * 60);
}

async function findGoogleEventForIssue(calendar, issueId) {
  const response = await calendar.events.list({
    calendarId: GOOGLE_CALENDAR_ID,
    q: `#${issueId}`,
    maxResults: 10,
    singleEvents: false,
    showDeleted: false
  });

  return (
    response.data.items?.find(event =>
      event.summary?.startsWith(`#${issueId}`)
    ) || null
  );
}

function extractMeetLink(event) {
  return (
    event.hangoutLink ||
    event.conferenceData?.entryPoints?.find(e => e.entryPointType === 'video')?.uri ||
    null
  );
}

async function processGoogleMeet(issue) {
  if (!googleCalendarIsConfigured()) {
    return;
  }

  const hasMeetStatus =
  normalizeText(issue.status?.name) === normalizeText(GOOGLE_MEET_STATUS_NAME);

const hasDate = Boolean(issue.start_date || issue.due_date);
const hasTime = Boolean(getCustomFieldValue(issue, ALERT_FIELD_NAME));
const hasEstimatedTime = Boolean(getEstimatedMinutes(issue));

if (!hasMeetStatus || !hasDate || !hasTime || !hasEstimatedTime) {
  await deleteGoogleMeet(issue.id);
  return;
}


  const appointment = parseAppointmentDateTime(issue);

  if (!appointment) {
    return;
  }

  const estimatedMinutes = getEstimatedMinutes(issue);

  if (!estimatedMinutes) {
    return;
  }

  const startDate = appointment.dateTime;
  const endDate = new Date(
    startDate.getTime() + estimatedMinutes * 60000
  );

  const projectName = await getMeetProjectName(issue);

  const summary =
    `#${issue.id} - ${projectName} - ${issue.subject} - ${appointment.timeLabel}`;

  const signature = JSON.stringify({
    summary,
    start: startDate.toISOString(),
    end: endDate.toISOString()
  });

  const signatureKey = `redmine:meet:signature:${issue.id}`;
  const oldSignature = await redisGet(signatureKey);

  const calendar = getGoogleCalendarClient();

  let event = await findGoogleEventForIssue(calendar, issue.id);

  if (event && oldSignature === signature) {
    return;
  }

  const requestBody = {
    summary,
    description: [
      `Tarefa Redmine: #${issue.id}`,
      `${REDMINE_URL}/issues/${issue.id}`
    ].join('\n'),
    start: getGoogleDateTimeObject(startDate),
    end: getGoogleDateTimeObject(endDate),
    extendedProperties: {
      private: {
        redmineIssueId: String(issue.id)
      }
    }
  };

  if (event?.id) {
    const response = await calendar.events.patch({
      calendarId: GOOGLE_CALENDAR_ID,
      eventId: event.id,
      conferenceDataVersion: 1,
      requestBody
    });

    event = response.data;

    console.log(`Meet atualizado issue #${issue.id}`);

  } else {
    const response = await calendar.events.insert({
      calendarId: GOOGLE_CALENDAR_ID,
      conferenceDataVersion: 1,
      requestBody: {
        ...requestBody,
        conferenceData: {
          createRequest: {
            requestId: `redmine-${issue.id}-${Date.now()}`,
            conferenceSolutionKey: {
              type: 'hangoutsMeet'
            }
          }
        }
      }
    });

    event = response.data;

    console.log(`Meet criado issue #${issue.id}`);
  }

  const meetLink = extractMeetLink(event);

  if (meetLink) {
    await updateRedmineCustomField(
      issue,
      GOOGLE_MEET_FIELD_NAME,
      meetLink
    );
  }

  await redisSet(signatureKey, signature);
}

function buildNotificationMessage(issue, action, source) {
  const meetLink = getCustomFieldValue(issue, GOOGLE_MEET_FIELD_NAME);

  return [
    `### Notificação do Redmine`,
    ``,
    `Você recebeu uma notificação da tarefa **#${issue.id}**.`,
    ``,
    `**Origem:** ${source}`,
    `**Ação:** ${action}`,
    `**Projeto:** ${issue.project?.name || ''}`,
    `**Assunto:** ${issue.subject}`,
    `**Status:** ${issue.status?.name || ''}`,
    `**Prioridade:** ${issue.priority?.name || ''}`,
    meetLink ? `**Google Meet:** ${meetLink}` : null,
    ``,
    `[Abrir tarefa no Redmine](${REDMINE_URL}/issues/${issue.id})`
  ].filter(Boolean).join('\n');
}

function buildAppointmentMessage(issue, alertMinutes, timeLabel) {
  const meetLink = getCustomFieldValue(issue, GOOGLE_MEET_FIELD_NAME);

  return [
    `### Lembrete de compromisso`,
    ``,
    `Faltam **${alertMinutes} minutos** para o compromisso da tarefa **#${issue.id}**.`,
    ``,
    `**Projeto:** ${issue.project?.name || ''}`,
    `**Assunto:** ${issue.subject}`,
    `**Data:** ${issue.start_date || issue.due_date || ''}`,
    `**Horário:** ${timeLabel}`,
    meetLink ? `**Google Meet:** ${meetLink}` : null,
    ``,
    `[Abrir tarefa no Redmine](${REDMINE_URL}/issues/${issue.id})`
  ].filter(Boolean).join('\n');
}

async function processIssueNotification(issue, action, source, journal = null) {
  if (shouldIgnoreIssueByStatus(issue)) {
    return;
  }
  if (normalizeText(issue.status?.name) === normalizeText(GOOGLE_MEET_STATUS_NAME)) {
  await processGoogleMeet(issue);
  return;
}
  await processGoogleMeet(issue);

  const eventKey = getEventKey(issue, source, journal);

  if (await wasAlreadyNotified(eventKey)) {
    return;
  }

  const targets = await getResponsibleTargets(issue);

  if (!targets.length) {
    return;
  }

  const message = buildNotificationMessage(
    issue,
    action,
    source
  );

  await notifyTargets(targets, message);

  await markAsNotified(eventKey);
}

async function checkAppointmentAlert(issue) {
  if (shouldIgnoreIssueByStatus(issue)) {
    return;
  }

  const appointment = parseAppointmentDateTime(issue);

  if (!appointment) {
    return;
  }

  const alertMinutesList = [
    Number(ALERT_MINUTES_BEFORE),
    Number(ALERT_EXTRA_MINUTES_BEFORE)
  ].filter((value, index, array) =>
    value > 0 && array.indexOf(value) === index
  );

  for (const alertMinutes of alertMinutesList) {
    const alertAt = new Date(
      appointment.dateTime.getTime() - alertMinutes * 60000
    );

    const now = new Date();
    const diffMs = now.getTime() - alertAt.getTime();
    const windowMs = Number(ALERT_POLLING_INTERVAL_SECONDS) * 1000;

    if (diffMs < 0 || diffMs > windowMs) {
      continue;
    }

    const alertKey =
      `redmine:appointment:${issue.id}:${appointment.dateTime.toISOString()}:${alertMinutes}`;

    if (await wasAppointmentAlertSent(alertKey)) {
      continue;
    }

    const targets = await getResponsibleTargets(issue);

    if (!targets.length) {
      await markAppointmentAlertSent(alertKey);
      continue;
    }

    const message = buildAppointmentMessage(
      issue,
      alertMinutes,
      appointment.timeLabel
    );

    await notifyTargets(targets, message);

    await markAppointmentAlertSent(alertKey);
  }
}

async function deleteGoogleMeet(issueId) {
  if (!googleCalendarIsConfigured()) {
    return;
  }

  const eventIdKey = `redmine:meet:event:${issueId}`;
  const signatureKey = `redmine:meet:signature:${issueId}`;

  const eventId = await redisGet(eventIdKey);

  if (!eventId) {
    return;
  }

  try {
    const calendar = getGoogleCalendarClient();

    await calendar.events.delete({
      calendarId: GOOGLE_CALENDAR_ID,
      eventId
    });

    console.log(`Meet excluído issue #${issueId}.`);

    await redisSet(eventIdKey, '');
    await redisSet(signatureKey, '');

  } catch (error) {
    const status = error.response?.status;

    if (status === 404 || status === 410) {
      console.log(`Meet issue #${issueId} já não existe no Google Calendar.`);
      await redisSet(eventIdKey, '');
      await redisSet(signatureKey, '');
      return;
    }

    console.error(
      `Erro ao excluir Meet issue #${issueId}:`,
      error.response?.data || error.message
    );
  }
}

function getBrazilDateParts(date = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });

  const parts = formatter.formatToParts(date);
  const get = type => parts.find(p => p.type === type)?.value;

  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    weekday: get('weekday'),
    hour: Number(get('hour')),
    minute: Number(get('minute'))
  };
}

function getBrazilDateString(date = new Date()) {
  const p = getBrazilDateParts(date);
  return `${p.year}-${p.month}-${p.day}`;
}

function getNextBusinessSummaryDateString() {
  const now = new Date();
  const p = getBrazilDateParts(now);

  const weekdayMap = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6
  };

  const weekday = weekdayMap[p.weekday];

  const target = new Date(now);

  // Sexta-feira resume segunda-feira
  if (weekday === 5) {
    target.setDate(target.getDate() + 3);
  } else {
    target.setDate(target.getDate() + 1);
  }

  return getBrazilDateString(target);
}

function isDailySummaryTime() {
  const p = getBrazilDateParts();

  const weekdayMap = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6
  };

  const weekday = weekdayMap[p.weekday];

  // Segunda a sexta às 17h45
  const allowedDay = weekday >= 1 && weekday <= 5;

  return (
    allowedDay &&
    p.hour === Number(DAILY_SUMMARY_HOUR) &&
    p.minute === Number(DAILY_SUMMARY_MINUTE)
  );
}

async function fetchIssuesByDate(dateStr) {
  const response = await axios.get(
    `${REDMINE_URL}/issues.json`,
    {
      headers: redmineHeaders,
      params: {
        status_id: '*',
        sort: 'start_date:asc',
        limit: 100
      }
    }
  );

  const issues = response.data.issues || [];

  return issues.filter(issue =>
    issue.start_date === dateStr ||
    issue.due_date === dateStr
  );
}

async function buildDailySummaryLine(issue) {
  const projectName = await getMeetProjectName(issue);
  const horario = getCustomFieldValue(issue, ALERT_FIELD_NAME) || '';

  return {
    sort: `${issue.start_date || issue.due_date || ''} ${horario}`,
    text: `#${issue.id} - ${projectName} - ${issue.subject} - ${horario}`
  };
}

async function processDailySummary() {
  if (DAILY_SUMMARY_ENABLED !== 'true') {
    return;
  }

  if (!isDailySummaryTime()) {
    return;
  }

  const tomorrow = getNextBusinessSummaryDateString();
  const summaryKey = `redmine:daily-summary:${tomorrow}`;

  if (await wasAlreadyNotified(summaryKey)) {
    return;
  }

  const issueSummaries = await fetchIssuesByDate(tomorrow);
  const groupedByEmail = new Map();

  for (const issueSummary of issueSummaries) {
    if (shouldIgnoreIssueByStatus(issueSummary)) {
      continue;
    }

    const issue = await fetchIssueDetails(issueSummary.id);
    const horario = getCustomFieldValue(issue, ALERT_FIELD_NAME);

    if (!horario) {
      continue;
    }

    const targets = await getResponsibleTargets(issue);

    if (!targets.length) {
      continue;
    }

    const line = await buildDailySummaryLine(issue);

    for (const target of targets) {
      if (!groupedByEmail.has(target.email)) {
        groupedByEmail.set(target.email, {
          target,
          lines: []
        });
      }

      groupedByEmail.get(target.email).lines.push(line);
    }
  }

  for (const { target, lines } of groupedByEmail.values()) {
    lines.sort((a, b) => a.sort.localeCompare(b.sort));

    const message = [
      `### Resumo de compromissos de amanhã`,
      ``,
      `Data: **${tomorrow}**`,
      ``,
      ...lines.map(l => `- ${l.text}`)
    ].join('\n');

    await notifyTargets([target], message);
  }

  await markAsNotified(summaryKey);
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

async function pollingRedmineIssues() {
  console.log('Polling Redmine iniciado.');

  try {
    const issues = await fetchRecentIssues();

    for (const issueSummary of issues) {
      const updatedAt = new Date(issueSummary.updated_on).getTime();

      if (updatedAt < lastPollingTimestamp) {
        continue;
      }

      try {
        const issue = await fetchIssueDetails(issueSummary.id);

        const issueWithUrl = {
          ...issue,
          url: `${REDMINE_URL}/issues/${issue.id}`
        };

        await processGoogleMeet(issueWithUrl);
        await checkAppointmentAlert(issueWithUrl);

        const lastJournal = getLastJournal(issueWithUrl);
        const eventKey = getEventKey(issueWithUrl, 'Polling', lastJournal);

        if (await wasAlreadyNotified(eventKey)) {
          continue;
        }

        await processIssueNotification(
          issueWithUrl,
          'Responsável alterado ou verificação periódica',
          'Polling',
          lastJournal
        );

      } catch (errorIssue) {
        console.error(
          `Erro polling issue #${issueSummary.id}:`,
          errorIssue.response?.data || errorIssue.message
        );
      }
    }

    lastPollingTimestamp = Date.now();

  } catch (error) {
    console.error(
      'Erro geral polling:',
      error.response?.data || error.message
    );
  }
}

async function pollingAppointmentAlerts() {
  try {
    const today = getBrazilDateString();
    const issues = await fetchIssuesByDate(today);

    for (const issueSummary of issues) {
      try {
        const issue = await fetchIssueDetails(issueSummary.id);

        const issueWithUrl = {
          ...issue,
          url: `${REDMINE_URL}/issues/${issue.id}`
        };

        await processGoogleMeet(issueWithUrl);
        await checkAppointmentAlert(issueWithUrl);

      } catch (errorIssue) {
        console.error(
          `Erro alerta issue #${issueSummary.id}:`,
          errorIssue.response?.data || errorIssue.message
        );
      }
    }

  } catch (error) {
    console.error(
      'Erro geral alertas:',
      error.response?.data || error.message
    );
  }
}

app.post('/redmine-webhook', async (req, res) => {
  try {
    const payload = getPayloadData(req.body);
    const issue = payload.issue;
    const action = payload.action || 'updated';
    const deletedActions = ['deleted', 'destroyed', 'destroy'];

if (deletedActions.includes(String(action).toLowerCase())) {
  const issueId = payload.issue?.id || payload.id;

  if (issueId) {
    await deleteGoogleMeet(issueId);
  }

  return res.status(200).json({
    success: true,
    message: 'Tarefa excluída. Meet removido, se existia.'
  });
}
    const journal = payload.journal || null;

    if (!issue) {
      return res.status(200).json({
        message: 'Payload sem issue.'
      });
    }

    const issueWithUrl = {
      ...issue,
      url: `${REDMINE_URL}/issues/${issue.id}`
    };

    await processIssueNotification(
      issueWithUrl,
      action,
      'Webhook',
      journal
    );

    await checkAppointmentAlert(issueWithUrl);

    return res.status(200).json({
      success: true
    });

  } catch (error) {
    console.error(
      'Erro webhook:',
      error.response?.data || error.message
    );

    return res.status(500).json({
      success: false,
      error: error.response?.data || error.message
    });
  }
});

app.get('/polling-now', async (req, res) => {
  await pollingRedmineIssues();
  await pollingAppointmentAlerts();
  await processDailySummary();

  res.json({
    success: true
  });
});

app.get('/', (req, res) => {
  res.send('API Redmine → Mattermost funcionando.');
});

app.listen(PORT, () => {
  console.log(`Servidor rodando porta ${PORT}`);

  if (POLLING_ENABLED === 'true') {
    setTimeout(async () => {
      await pollingRedmineIssues();
      await pollingAppointmentAlerts();
      await processDailySummary();
    }, 10000);

    setInterval(
      pollingRedmineIssues,
      Number(POLLING_INTERVAL_SECONDS) * 1000
    );

    setInterval(
      pollingAppointmentAlerts,
      Number(ALERT_POLLING_INTERVAL_SECONDS) * 1000
    );

    setInterval(
      processDailySummary,
      60 * 1000
    );
  }
});