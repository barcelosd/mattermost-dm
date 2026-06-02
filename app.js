require('dotenv').config();

const express = require('express');
const axios = require('axios');
const Redis = require('ioredis');
const { google } = require('googleapis');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
const customParseFormat = require('dayjs/plugin/customParseFormat');
const qrcode = require('qrcode-terminal');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason
} = require('@whiskeysockets/baileys');
const pino = require('pino');

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(customParseFormat);

// ---------------------------------------------------------
// CONFIGURAÇÕES
// ---------------------------------------------------------
const {
  PORT = 3000,

  REDMINE_URL,
  REDMINE_API_KEY,

  MATTERMOST_URL,
  MATTERMOST_TOKEN,

  REDIS_URL,
  REDIS_TTL_DAYS = 90,

  POLLING_ENABLED = 'true',
  POLLING_INTERVAL_SECONDS = 60,
  POLLING_LIMIT = 20,

  ALERT_MINUTES_BEFORE = 10,
  ALERT_EXTRA_MINUTES_BEFORE = 2,
  WHATSAPP_ALERT_MINUTES_BEFORE = 5,
  ALERT_WINDOW_SECONDS = 180,
  ALERT_FIELD_NAME = 'Horário',
  ALERT_POLLING_INTERVAL_SECONDS = 60,

  DAILY_SUMMARY_ENABLED = 'true',
  DAILY_SUMMARY_HOUR = 17,
  DAILY_SUMMARY_MINUTE = 45,

  CLIENT_SUMMARY_ENABLED = 'true',
  CLIENT_SUMMARY_TIME = '10:30',

  NOTIFY_STATUSES = 'Novo,Reaberta',
  MEET_STATUS_NAME = 'Aguardando Data',

  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REFRESH_TOKEN,
  GOOGLE_CALENDAR_ID,

  GOOGLE_DRIVE_CLIENTES_FOLDER_ID,
  GOOGLE_DRIVE_RECORDINGS_FOLDER_ID,
  GOOGLE_MEET_PROJECT_FIELD_NAME = 'Nome Fantasia',

  WHATSAPP_GROUP_FIELD_NAME = 'ID Grupo WhatsApp'
} = process.env;

const TZ = 'America/Sao_Paulo';

const redmineHeaders = {
  'X-Redmine-API-Key': REDMINE_API_KEY,
  'Content-Type': 'application/json'
};

const mattermostHeaders = {
  Authorization: `Bearer ${MATTERMOST_TOKEN}`,
  'Content-Type': 'application/json'
};

// ---------------------------------------------------------
// WHATSAPP
// ---------------------------------------------------------
let waSocket = null;

async function initWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('/opt/render/project/src/.wwebjs_auth');

  waSocket = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: ['Bot NewNorte', 'Chrome', '1.0.0']
  });

  waSocket.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('--- NOVO QR CODE GERADO ---');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;

      if (shouldReconnect) {
        initWhatsApp();
      }
    }

    if (connection === 'open') {
      console.log('WhatsApp conectado com sucesso!');
    }
  });

  waSocket.ev.on('creds.update', saveCreds);

  waSocket.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      '';

    const from = msg.key.remoteJid;

    if (text.trim().toLowerCase() === '!id') {
      try {
        await waSocket.sendMessage(
          from,
          {
            text: `🆔 *ID deste bate-papo/grupo:*\n\`${from}\``
          },
          { quoted: msg }
        );
      } catch (err) {
        console.error('Erro ao responder !id:', err.message);
      }
    }
  });
}

initWhatsApp();

// ---------------------------------------------------------
// REDIS / CACHE LOCAL
// ---------------------------------------------------------
const redis = REDIS_URL
  ? new Redis(REDIS_URL, {
      maxRetriesPerRequest: 1,
      enableReadyCheck: false
    })
  : null;

const memory = {
  values: new Map(),
  meetIssues: new Set(),
  notified: new Set(),
  alerts: new Set()
};

async function redisSet(key, value, customTtl) {
  const ttl = customTtl || Number(REDIS_TTL_DAYS) * 86400;

  if (redis) {
    await redis.set(key, value, 'EX', ttl);
    return;
  }

  memory.values.set(key, value);
  setTimeout(() => memory.values.delete(key), ttl * 1000);
}

async function redisGet(key) {
  if (redis) return redis.get(key);
  return memory.values.get(key) || null;
}

async function redisDel(key) {
  if (redis) await redis.del(key);
  else memory.values.delete(key);
}

async function redisSetAdd(key, value) {
  if (redis) await redis.sadd(key, value);
  else memory.meetIssues.add(value);
}

async function redisSetRemove(key, value) {
  if (redis) await redis.srem(key, value);
  else memory.meetIssues.delete(value);
}

async function wasAlreadyNotified(key) {
  if (redis) return (await redis.get(key)) === '1';
  return memory.notified.has(key);
}

async function markAsNotified(key) {
  const ttl = Number(REDIS_TTL_DAYS) * 86400;

  if (redis) {
    await redis.set(key, '1', 'EX', ttl);
    return;
  }

  memory.notified.add(key);
  setTimeout(() => memory.notified.delete(key), ttl * 1000);
}

// Alertas usam memória local para reduzir consumo de Redis.
// A chave inclui tarefa + data + horário + tipo de alerta.
async function wasAppointmentAlertSent(key) {
  return memory.alerts.has(key);
}

async function markAppointmentAlertSent(key) {
  const ttl = 48 * 60 * 60;

  memory.alerts.add(key);
  setTimeout(() => memory.alerts.delete(key), ttl * 1000);
}

// ---------------------------------------------------------
// UTILITÁRIOS
// ---------------------------------------------------------
function normalizeText(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function shouldNotifyStandardStatus(issue) {
  const status = normalizeText(issue?.status?.name || issue?.status || '');

  const allowedStatuses = String(NOTIFY_STATUSES)
    .split(',')
    .map(normalizeText)
    .filter(Boolean);

  return allowedStatuses.includes(status);
}

function isStrictMeetStatus(issue) {
  const status = normalizeText(issue?.status?.name || issue?.status || '');
  return status === normalizeText(MEET_STATUS_NAME);
}

function getLastJournal(issue) {
  return issue?.journals?.length
    ? issue.journals[issue.journals.length - 1]
    : null;
}

function getEventKey(issue, source, journal) {
  const statusLabel = normalizeText(issue?.status?.name || issue?.status || 'unknown');
  return `redmine:standard_notify:${statusLabel}:${issue.id}:${journal ? journal.id : source}`;
}

function getCustomFieldValue(entity, fieldName) {
  const fields = entity?.custom_fields || entity?.custom_field_values || [];

  const field = fields.find(
    f => f.name === fieldName || f.custom_field_name === fieldName
  );

  return field?.value || null;
}

function setCustomFieldValue(issue, fieldName, value) {
  const fields = issue?.custom_fields || issue?.custom_field_values || [];

  const field = fields.find(
    f => f.name === fieldName || f.custom_field_name === fieldName
  );

  if (field) {
    field.value = value;
  }
}

function getCustomFieldId(issue, fieldName) {
  const fields = issue?.custom_fields || issue?.custom_field_values || [];

  const field = fields.find(
    f => f.name === fieldName || f.custom_field_name === fieldName
  );

  return field?.id || field?.custom_field_id || null;
}

function parseAppointmentDateTime(issue) {
  const date = issue.start_date || issue.due_date;
  const timeValueRaw = getCustomFieldValue(issue, ALERT_FIELD_NAME);

  if (!date || !timeValueRaw) return null;

  const timeValue = String(timeValueRaw)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '');

  const parsedTime = dayjs(timeValue, ['HH:mm', 'HHhmm', 'HHh'], false);

  if (!parsedTime.isValid()) return null;

  const dateTime = dayjs.tz(
    `${date} ${parsedTime.format('HH:mm')}`,
    'YYYY-MM-DD HH:mm',
    TZ
  ).toDate();

  return {
    dateTime,
    timeLabel: parsedTime.format('HH[h]mm')
  };
}

function getEstimatedMinutes(issue) {
  const hours = Number(String(issue.estimated_hours || 0).replace(',', '.'));

  if (!hours || Number.isNaN(hours)) return null;

  return Math.round(hours * 60);
}

function isDailySummaryTime() {
  if (DAILY_SUMMARY_ENABLED !== 'true') return false;

  const now = dayjs().tz(TZ);

  if (now.day() === 0 || now.day() === 6) return false;

  return (
    now.hour() === Number(DAILY_SUMMARY_HOUR) &&
    now.minute() === Number(DAILY_SUMMARY_MINUTE)
  );
}

function getNextBusinessSummaryDateString() {
  let target = dayjs().tz(TZ);

  if (target.day() === 5) target = target.add(3, 'day');
  else if (target.day() === 6) target = target.add(2, 'day');
  else target = target.add(1, 'day');

  return target.format('YYYY-MM-DD');
}

// ---------------------------------------------------------
// REDMINE
// ---------------------------------------------------------
async function fetchIssueDetails(issueId) {
  const response = await axios.get(
    `${REDMINE_URL}/issues/${issueId}.json?include=journals`,
    { headers: redmineHeaders }
  );

  return response.data.issue;
}

async function updateRedmineCustomField(issue, fieldName, value) {
  const fieldId = getCustomFieldId(issue, fieldName);

  if (!fieldId) return;

  await axios.put(
    `${REDMINE_URL}/issues/${issue.id}.json`,
    {
      issue: {
        custom_fields: [{ id: fieldId, value }]
      }
    },
    { headers: redmineHeaders }
  );

  setCustomFieldValue(issue, fieldName, value);
}

async function getRedmineProject(projectId) {
  if (!projectId) return null;

  try {
    const response = await axios.get(
      `${REDMINE_URL}/projects/${projectId}.json`,
      { headers: redmineHeaders }
    );

    return response.data.project;
  } catch (err) {
    console.error(`Erro ao buscar projeto ${projectId}:`, err.response?.data || err.message);
    return null;
  }
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

function isRedmineUserActive(user) {
  return user && user.mail && (!user.status || Number(user.status) === 1);
}

async function getResponsibleTargets(issue) {
  const assignee = issue.assignee || issue.assigned_to;

  if (!assignee) return [];

  if (typeof assignee.id === 'string' && assignee.id.includes('@')) {
    return [
      {
        email: assignee.id.trim().toLowerCase(),
        name: assignee.name || assignee.id
      }
    ];
  }

  try {
    const user = await getRedmineUser(assignee.id);

    if (isRedmineUserActive(user)) {
      return [
        {
          email: user.mail.toLowerCase(),
          name: `${user.firstname} ${user.lastname}`.trim()
        }
      ];
    }
  } catch {}

  const group = await getRedmineGroup(assignee.id);

  if (!group?.users?.length) return [];

  const users = await Promise.all(
    group.users.map(async gUser => {
      try {
        const fullUser = await getRedmineUser(gUser.id);

        if (isRedmineUserActive(fullUser)) {
          return {
            email: fullUser.mail.toLowerCase(),
            name: `${fullUser.firstname} ${fullUser.lastname}`.trim()
          };
        }
      } catch {}

      return null;
    })
  );

  return users.filter(Boolean);
}

async function getWhatsAppGroupId(issue) {
  let groupId = getCustomFieldValue(issue, WHATSAPP_GROUP_FIELD_NAME);

  if (groupId) {
    return String(groupId).trim();
  }

  if (!issue.project?.id) return null;

  const project = await getRedmineProject(issue.project.id);

  if (!project) return null;

  groupId = getCustomFieldValue(project, WHATSAPP_GROUP_FIELD_NAME);

  if (groupId) {
    return String(groupId).trim();
  }

  return null;
}

// ---------------------------------------------------------
// MATTERMOST
// ---------------------------------------------------------
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

async function notifyTargets(targets, message) {
  try {
    const botUser = await getMattermostBotUser();

    for (const target of targets) {
      try {
        const mmUser = await getMattermostUserByEmail(target.email);

        if (mmUser.delete_at && mmUser.delete_at > 0) {
          console.log(`Mattermost ignorado, usuário baixado: ${target.email}`);
          continue;
        }

        const channel = await createDirectChannel(botUser.id, mmUser.id);

        await sendMattermostMessage(channel.id, message);

        console.log(`Mattermost enviado para ${target.email}`);
      } catch (error) {
        console.error(
          `Erro ao enviar Mattermost para ${target.email}:`,
          error.response?.data || error.message
        );
      }
    }
  } catch (err) {
    console.error('Erro geral no Mattermost:', err.response?.data || err.message);
  }
}

// ---------------------------------------------------------
// MENSAGENS
// ---------------------------------------------------------
function buildNotificationMessage(issue, action, source) {
  const meetLink = getCustomFieldValue(issue, 'Google Meet');

  return [
    `### Notificação do Redmine`,
    `Você recebeu uma notificação da tarefa **#${issue.id}**.`,
    `Origem: ${source} | Ação: ${action}`,
    `Projeto: ${issue.project?.name || ''} | Assunto: ${issue.subject}`,
    meetLink ? `Google Meet: ${meetLink}` : null,
    `[Abrir tarefa no Redmine](${REDMINE_URL}/issues/${issue.id})`
  ]
    .filter(Boolean)
    .join('\n');
}

function buildAppointmentMessage(issue, alertMinutes, timeLabel) {
  const meetLink = getCustomFieldValue(issue, 'Google Meet');

  return [
    `### ⏰ Lembrete de Reunião`,
    `Faltam **${alertMinutes} minutos** para o compromisso da tarefa **#${issue.id}**.`,
    `Projeto: ${issue.project?.name || ''} | Assunto: ${issue.subject} | Horário: ${timeLabel}`,
    meetLink ? `Link do Google Meet: ${meetLink}` : null,
    `[Abrir tarefa no Redmine](${REDMINE_URL}/issues/${issue.id})`
  ]
    .filter(Boolean)
    .join('\n');
}

function buildWhatsAppMessage(issue, alertMinutes, timeLabel) {
  const meetLink = getCustomFieldValue(issue, 'Google Meet');
  const publicoAlvoRaw = getCustomFieldValue(issue, 'Público Alvo');

  let publicoAlvo = '';

  if (publicoAlvoRaw) {
    publicoAlvo = Array.isArray(publicoAlvoRaw)
      ? publicoAlvoRaw
          .map(v => (typeof v === 'object' ? v.value || v.name : v))
          .join(' / ')
      : String(publicoAlvoRaw).trim();
  }

  let msg = `⏰ *Lembrete de Compromisso*\n\n`;
  msg += `Faltam ${alertMinutes} minutos para a reunião do seu compromisso.\n\n`;
  msg += `*Projeto:* ${issue.project?.name || ''}\n`;
  msg += `*Assunto:* ${issue.subject}\n`;

  if (publicoAlvo) {
    msg += `*Público Alvo:* ${publicoAlvo}\n`;
  }

  msg += `*Horário:* ${timeLabel}\n`;

  if (meetLink) {
    msg += `\n*👉 Link do Google Meet:*\n${meetLink}\n`;
  }

  msg += `\nEstamos te aguardando!\n\n`;
  msg += `⏳ *Observação:* O técnico permanecerá com a sala aberta por 10 minutos após o horário agendado.`;

  return msg;
}

function buildClientSummaryMessage(issue, timeLabel) {
  const meetLink = getCustomFieldValue(issue, 'Google Meet');
  const publicoAlvoRaw = getCustomFieldValue(issue, 'Público Alvo');

  let publicoAlvo = '';

  if (publicoAlvoRaw) {
    publicoAlvo = Array.isArray(publicoAlvoRaw)
      ? publicoAlvoRaw
          .map(v => (typeof v === 'object' ? v.value || v.name : v))
          .join(' / ')
      : String(publicoAlvoRaw).trim();
  }

  let msg = `📅 *Confirmação de Compromisso*\n\n`;
  msg += `Olá! Passando para lembrar do seu compromisso agendado para o próximo dia útil (${dayjs(issue.start_date || issue.due_date).format('DD/MM/YYYY')}).\n\n`;
  msg += `*Projeto:* ${issue.project?.name || ''}\n`;
  msg += `*Assunto:* ${issue.subject}\n`;

  if (publicoAlvo) {
    msg += `*Público Alvo:* ${publicoAlvo}\n`;
  }

  msg += `*Horário:* ${timeLabel}\n`;

  if (meetLink) {
    msg += `\n*👉 Link do Google Meet:*\n${meetLink}\n`;
  }

  msg += `\nPor favor, confirme respondendo a esta mensagem se está tudo confirmado para o nosso encontro! 😊`;

  return msg;
}

// ---------------------------------------------------------
// NOTIFICAÇÃO COMUM — NOVO / REABERTA
// ---------------------------------------------------------
async function processIssueNotification(issue, action, source, journal = null) {
  if (isStrictMeetStatus(issue)) return;

  if (!shouldNotifyStandardStatus(issue)) return;

  const eventKey = getEventKey(issue, source, journal);

  if (await wasAlreadyNotified(eventKey)) return;

  const targets = await getResponsibleTargets(issue);

  if (!targets.length) {
    console.log(`Tarefa #${issue.id} sem responsável ativo para notificação comum.`);
    return;
  }

  await notifyTargets(
    targets,
    buildNotificationMessage(issue, action, source)
  );

  await markAsNotified(eventKey);

  console.log(`Notificação comum enviada para tarefa #${issue.id}`);
}

// ---------------------------------------------------------
// ALERTAS — AGUARDANDO DATA
// ---------------------------------------------------------
async function checkAppointmentAlert(issue) {
  if (!isStrictMeetStatus(issue)) return;

  const appointment = parseAppointmentDateTime(issue);

  if (!appointment) {
    return;
  }

  const agora = dayjs().tz(TZ);
  const dataAgendamento = dayjs(appointment.dateTime).tz(TZ);

  const diffSegundos = dataAgendamento.diff(agora, 'second');

  // Ignora tarefa que já passou há mais de 10 minutos.
  const maxAlertMinutes = Math.max(
  Number(ALERT_MINUTES_BEFORE || 10),
  Number(ALERT_EXTRA_MINUTES_BEFORE || 2),
  Number(WHATSAPP_ALERT_MINUTES_BEFORE || 5)
);

// Começa a verificar apenas 2 minutos antes do primeiro alerta.
// Exemplo: primeiro alerta 10 min => começa com 12 min.
const startCheckingSeconds = (maxAlertMinutes + 2) * 60;

// Depois que passou do horário, não precisa mais verificar.
const stopAfterSeconds = 30;

if (diffSegundos > startCheckingSeconds) {
  return;
}

if (diffSegundos < -stopAfterSeconds) {
  return;
}

  const windowSeconds = Number(ALERT_WINDOW_SECONDS || 180);

  const mmMin1 = Number(ALERT_MINUTES_BEFORE || 10);
  const mmMin2 = Number(ALERT_EXTRA_MINUTES_BEFORE || 2);
  const waMin = Number(WHATSAPP_ALERT_MINUTES_BEFORE || 5);

  const appointmentKey = dataAgendamento.format('YYYYMMDDHHmm');

  if (
  diffSegundos <= startCheckingSeconds &&
  diffSegundos >= -stopAfterSeconds
) {
  console.log(
    `Verificando alerta #${issue.id} | ${appointment.timeLabel} | Faltam ${diffSegundos}s`
  );
}

  async function sendMattermostAlert(minutes) {
    const targetSec = minutes * 60;

    if (
      diffSegundos <= targetSec &&
      diffSegundos >= targetSec - windowSeconds
    ) {
      const alertKey = `redmine:mm:${issue.id}:${appointmentKey}:${minutes}`;

      if (await wasAppointmentAlertSent(alertKey)) {
        return;
      }

      const targets = await getResponsibleTargets(issue);

      if (!targets.length) {
        console.log(`Tarefa #${issue.id} sem responsável ativo para Mattermost.`);
        return;
      }

      await notifyTargets(
        targets,
        buildAppointmentMessage(issue, minutes, appointment.timeLabel)
      );

      await markAppointmentAlertSent(alertKey);

      console.log(`Mattermost enviado (${minutes} min) para tarefa #${issue.id}`);
    }
  }

  async function sendWhatsAppAlert(minutes) {
    const targetSec = minutes * 60;

    if (
      diffSegundos <= targetSec &&
      diffSegundos >= targetSec - windowSeconds
    ) {
      const alertKey = `redmine:wa:${issue.id}:${appointmentKey}:${minutes}`;

      if (await wasAppointmentAlertSent(alertKey)) {
        return;
      }

      const waGroupId = await getWhatsAppGroupId(issue);

      if (!waGroupId) {
        console.log(`Tarefa #${issue.id} sem grupo WhatsApp.`);
        return;
      }

      if (!waSocket) {
        console.log('WhatsApp desconectado.');
        return;
      }

      let groupJid = String(waGroupId).trim();

      if (!groupJid.includes('@')) {
        groupJid = `${groupJid}@g.us`;
      }

      console.log(`Tarefa #${issue.id} usando grupo WhatsApp: ${groupJid}`);

      await waSocket.sendMessage(groupJid, {
        text: buildWhatsAppMessage(issue, minutes, appointment.timeLabel)
      });

      await markAppointmentAlertSent(alertKey);

      console.log(`WhatsApp enviado (${minutes} min) para tarefa #${issue.id}`);
    }
  }

  await sendMattermostAlert(mmMin1);
  await sendWhatsAppAlert(waMin);
  await sendMattermostAlert(mmMin2);
}

// ---------------------------------------------------------
// GOOGLE CALENDAR / MEET
// ---------------------------------------------------------
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

function getGoogleDriveClient() {
  const auth = new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET
  );

  auth.setCredentials({
    refresh_token: GOOGLE_REFRESH_TOKEN
  });

  return google.drive({
    version: 'v3',
    auth
  });
}

async function getMeetProjectName(issue) {
  if (!issue.project?.id) return '';

  const project = await getRedmineProject(issue.project.id);

  return (
    getCustomFieldValue(project, GOOGLE_MEET_PROJECT_FIELD_NAME) ||
    project?.parent?.name ||
    project?.name ||
    issue.project?.name ||
    ''
  );
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

async function deleteGoogleMeet(issueId) {
  if (!googleCalendarIsConfigured()) return;

  const calendar = getGoogleCalendarClient();

  let eventId = await redisGet(`redmine:meet:event:${issueId}`);

  try {
    if (!eventId) {
      const event = await findGoogleEventForIssue(calendar, issueId);
      eventId = event?.id || null;
    }

    if (eventId) {
      await calendar.events.delete({
        calendarId: GOOGLE_CALENDAR_ID,
        eventId
      });

      console.log(`Google Meet removido da tarefa #${issueId}`);
    }
  } catch (error) {
    console.error(
      `Erro ao excluir Meet da tarefa #${issueId}:`,
      error.response?.data || error.message
    );
  } finally {
    await redisDel(`redmine:meet:event:${issueId}`);
    await redisDel(`redmine:meet:signature:${issueId}`);
    await redisDel(`redmine:meet:link:${issueId}`);
    await redisSetRemove('redmine:meet:issues', String(issueId));
  }
}

async function processGoogleMeet(issue) {
  if (!googleCalendarIsConfigured()) return;

  const isMeet = isStrictMeetStatus(issue);
  const appointment = parseAppointmentDateTime(issue);
  const estimatedMinutes = getEstimatedMinutes(issue);

  if (!isMeet || !appointment || !estimatedMinutes) {
    await deleteGoogleMeet(issue.id);
    return;
  }

  const startDate = appointment.dateTime;
  const endDate = new Date(startDate.getTime() + estimatedMinutes * 60000);

  const projectName = await getMeetProjectName(issue);

  await getOrCreateClientFolderStructure(issue).catch(() => {});

  const summary = `#${issue.id} - ${projectName} - ${issue.subject} - ${appointment.timeLabel}`;

  const signature = JSON.stringify({
    summary,
    start: startDate.toISOString(),
    end: endDate.toISOString()
  });

  const signatureKey = `redmine:meet:signature:${issue.id}`;

  const oldSignature = await redisGet(signatureKey);

  const calendar = getGoogleCalendarClient();

  let eventId = await redisGet(`redmine:meet:event:${issue.id}`);
  let event = null;

  if (eventId) {
    try {
      event = (
        await calendar.events.get({
          calendarId: GOOGLE_CALENDAR_ID,
          eventId
        })
      ).data;
    } catch {
      eventId = null;
    }
  }

  if (!eventId) {
    event = await findGoogleEventForIssue(calendar, issue.id);
    eventId = event?.id || null;
  }

  if (eventId && oldSignature === signature) {
    const meetLink = await redisGet(`redmine:meet:link:${issue.id}`);

    if (
      meetLink &&
      getCustomFieldValue(issue, 'Google Meet') !== meetLink
    ) {
      await updateRedmineCustomField(issue, 'Google Meet', meetLink);
    }

    return;
  }

  const requestBody = {
    summary,
    description: `Tarefa Redmine: #${issue.id}\n${REDMINE_URL}/issues/${issue.id}`,
    start: {
      dateTime: startDate.toISOString(),
      timeZone: TZ
    },
    end: {
      dateTime: endDate.toISOString(),
      timeZone: TZ
    },
    extendedProperties: {
      private: {
        RedmineIssueId: String(issue.id)
      }
    }
  };

  try {
    if (eventId) {
      const response = await calendar.events.patch({
        calendarId: GOOGLE_CALENDAR_ID,
        eventId,
        conferenceDataVersion: 1,
        requestBody
      });

      event = response.data;
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
    }

    const meetLink = extractMeetLink(event);

    if (meetLink) {
      await updateRedmineCustomField(issue, 'Google Meet', meetLink);
      await redisSet(`redmine:meet:link:${issue.id}`, meetLink);
    }

    await redisSet(`redmine:meet:event:${issue.id}`, event.id);
    await redisSetAdd('redmine:meet:issues', String(issue.id));
    await redisSet(signatureKey, signature);

    console.log(`Google Meet sincronizado para tarefa #${issue.id}`);
  } catch (error) {
    console.error(
      `Erro ao sincronizar Google Meet da tarefa #${issue.id}:`,
      error.response?.data || error.message
    );
  }
}

// ---------------------------------------------------------
// GOOGLE DRIVE
// ---------------------------------------------------------
async function getOrCreateFolder(drive, name, parentId) {
  let query =
    `name = '${name.replace(/'/g, "\\'")}' ` +
    `and mimeType = 'application/vnd.google-apps.folder' ` +
    `and trashed = false`;

  if (parentId) {
    query += ` and '${parentId}' in parents`;
  }

  const res = await drive.files.list({
    q: query,
    fields: 'files(id)'
  });

  const found = res.data.files || res.data.items || [];

  if (found.length > 0) {
    return found[0].id;
  }

  const metadata = {
    name,
    mimeType: 'application/vnd.google-apps.folder',
    parents: parentId ? [parentId] : []
  };

  const folder = await drive.files.create({
    resource: metadata,
    fields: 'id'
  });

  return folder.data.id;
}

async function getOrCreateClientFolderStructure(issue) {
  if (!GOOGLE_DRIVE_CLIENTES_FOLDER_ID || !issue?.project?.id) return null;

  try {
    const project = await getRedmineProject(issue.project.id);

    if (!project) return null;

    const sincroniza = getCustomFieldValue(project, 'Sincroniza G-Drive');

    if (
      !sincroniza ||
      String(sincroniza).trim().toLowerCase() !== 'sim'
    ) {
      return null;
    }

    const personalizacaoRaw = getCustomFieldValue(project, 'Personalização');
    const nomeFantasiaRaw =
      getCustomFieldValue(project, 'Nome Fantasia') || project.name;

    const personalizacao = personalizacaoRaw
      ? String(personalizacaoRaw).trim()
      : '';

    const nomeFantasia = nomeFantasiaRaw
      ? String(nomeFantasiaRaw).trim()
      : '';

    const folderName = personalizacao
      ? `${personalizacao} - ${nomeFantasia}`
      : nomeFantasia;

    const drive = getGoogleDriveClient();

    const clientFolderId = await getOrCreateFolder(
      drive,
      folderName,
      GOOGLE_DRIVE_CLIENTES_FOLDER_ID
    );

    const treinamentosFolderId = await getOrCreateFolder(
      drive,
      'Treinamentos',
      clientFolderId
    );

    const arquivosFolderId = await getOrCreateFolder(
      drive,
      'Arquivos',
      clientFolderId
    );

    return {
      clientFolderId,
      treinamentosFolderId,
      arquivosFolderId
    };
  } catch (err) {
    console.error('Erro ao criar estrutura Drive:', err.response?.data || err.message);
    return null;
  }
}

async function processMeetRecordings() {
  if (!GOOGLE_DRIVE_RECORDINGS_FOLDER_ID || !googleCalendarIsConfigured()) return;

  try {
    const drive = getGoogleDriveClient();

    const res = await drive.files.list({
      q: `'${GOOGLE_DRIVE_RECORDINGS_FOLDER_ID}' in parents and trashed = false`,
      fields: 'files(id, name)'
    });

    const files = res.data.files || res.data.items || [];

    for (const file of files) {
      const match = file.name.match(/#(\d+)/);

      if (!match) continue;

      const issueId = match[1];

      try {
        const issue = await fetchIssueDetails(issueId);

        const structure = await getOrCreateClientFolderStructure(issue);

        if (structure?.treinamentosFolderId) {
          await drive.files.update({
            fileId: file.id,
            addParents: structure.treinamentosFolderId,
            removeParents: GOOGLE_DRIVE_RECORDINGS_FOLDER_ID,
            fields: 'id, parents'
          });

          console.log(`Gravação movida para tarefa #${issueId}`);
        }
      } catch (err) {
        console.error(
          `Erro ao mover gravação da tarefa #${issueId}:`,
          err.response?.data || err.message
        );
      }
    }
  } catch (error) {
    console.error(
      'Erro geral no processamento de gravações:',
      error.response?.data || error.message
    );
  }
}

// ---------------------------------------------------------
// POLLING REDMINE
// ---------------------------------------------------------
let lastPollingTimestamp = Date.now() - 10 * 60 * 1000;

async function fetchRecentIssues() {
  const response = await axios.get(`${REDMINE_URL}/issues.json`, {
    headers: redmineHeaders,
    params: {
      status_id: '*',
      sort: 'updated_on:desc',
      limit: Number(POLLING_LIMIT)
    }
  });

  return response.data.issues || [];
}

async function pollingRedmineIssues() {
  if (POLLING_ENABLED !== 'true') return;

  try {
    const issues = await fetchRecentIssues();

    for (const issueSummary of issues) {
      const updatedAt = new Date(issueSummary.updated_on).getTime();

      if (updatedAt < lastPollingTimestamp) continue;

      try {
        const issue = await fetchIssueDetails(issueSummary.id);

        const issueWithUrl = {
          ...issue,
          url: `${REDMINE_URL}/issues/${issue.id}`
        };

        await processGoogleMeet(issueWithUrl);

        const lastJournal = getLastJournal(issueWithUrl);

        await processIssueNotification(
          issueWithUrl,
          'Atualização',
          'Polling',
          lastJournal
        );
      } catch (err) {
        if (err.response?.status === 404) {
          await deleteGoogleMeet(issueSummary.id);
        } else {
          console.error(
            `Erro no polling da tarefa #${issueSummary.id}:`,
            err.response?.data || err.message
          );
        }
      }
    }

    lastPollingTimestamp = Date.now();
  } catch (error) {
    console.error('Erro geral no polling:', error.response?.data || error.message);
  }
}

async function fetchIssuesByDate(dateStr) {
  async function fetchByField(field) {
    const response = await axios.get(`${REDMINE_URL}/issues.json`, {
      headers: redmineHeaders,
      params: {
        set_filter: 1,
        status_id: '*',
        'f[]': field,
        [`op[${field}]`]: '=',
        [`v[${field}][]`]: dateStr,
        limit: 100
      }
    });

    return response.data.issues || [];
  }

  try {
    const [byStartDate, byDueDate] = await Promise.all([
      fetchByField('start_date').catch(() => []),
      fetchByField('due_date').catch(() => [])
    ]);

    const combined = [...byStartDate, ...byDueDate];

    return Array.from(
      new Map(combined.map(issue => [issue.id, issue])).values()
    );
  } catch (error) {
    console.error(
      'Erro ao buscar tarefas por data:',
      error.response?.data || error.message
    );

    return [];
  }
}

async function pollingAppointmentAlerts() {
  try {
    const today = dayjs().tz(TZ).format('YYYY-MM-DD');

    const issues = await fetchIssuesByDate(today);

    for (const issueSummary of issues) {
      try {
        const issue = await fetchIssueDetails(issueSummary.id);

        const issueWithUrl = {
          ...issue,
          url: `${REDMINE_URL}/issues/${issue.id}`
        };

        await checkAppointmentAlert(issueWithUrl);
      } catch (err) {
        console.error(
          `Erro ao verificar alerta da tarefa #${issueSummary.id}:`,
          err.response?.data || err.message
        );
      }
    }
  } catch (error) {
    console.error(
      'Erro geral no polling de alertas:',
      error.response?.data || error.message
    );
  }
}

// ---------------------------------------------------------
// RESUMO MATTERMOST
// ---------------------------------------------------------
async function processDailySummary() {
  if (!isDailySummaryTime()) return;

  const targetDate = getNextBusinessSummaryDateString();
  const summaryKey = `redmine:summary:mattermost:${targetDate}`;

  if (await wasAlreadyNotified(summaryKey)) return;

  try {
    const issueSummaries = await fetchIssuesByDate(targetDate);
    const groupedByEmail = new Map();

    for (const issueSummary of issueSummaries) {
      const issue = await fetchIssueDetails(issueSummary.id);

      if (!isStrictMeetStatus(issue)) continue;

      const appointment = parseAppointmentDateTime(issue);

      if (!appointment) continue;

      const targets = await getResponsibleTargets(issue);

      if (!targets.length) continue;

      const projectName = await getMeetProjectName(issue);
      const meetLink = getCustomFieldValue(issue, 'Google Meet');

      const sortKey = `${issue.start_date || issue.due_date || ''} ${appointment.timeLabel}`;

      const lineText =
        `- ${appointment.timeLabel}: #${issue.id} - ${projectName} - ${issue.subject}` +
        `${meetLink ? ` (Meet: ${meetLink})` : ''}`;

      for (const target of targets) {
        if (!groupedByEmail.has(target.email)) {
          groupedByEmail.set(target.email, {
            target,
            lines: []
          });
        }

        groupedByEmail.get(target.email).lines.push({
          sort: sortKey,
          text: lineText
        });
      }
    }

    for (const { target, lines } of groupedByEmail.values()) {
      lines.sort((a, b) => a.sort.localeCompare(b.sort));

      const message = [
        `### 📅 Resumo de Compromissos — Próximo Dia Útil`,
        `Data: **${dayjs(targetDate).format('DD/MM/YYYY')}**\n`,
        ...lines.map(l => l.text)
      ].join('\n');

      await notifyTargets([target], message);
    }

    await markAsNotified(summaryKey);

    console.log(`Resumo Mattermost enviado para ${targetDate}`);
  } catch (error) {
    console.error(
      'Erro no resumo Mattermost:',
      error.response?.data || error.message
    );
  }
}

// ---------------------------------------------------------
// RESUMO WHATSAPP CLIENTE
// ---------------------------------------------------------
async function processClientMorningSummary() {
  if (CLIENT_SUMMARY_ENABLED !== 'true') return;

  const now = dayjs().tz(TZ);
  const [tHour, tMinute] = String(CLIENT_SUMMARY_TIME || '08:30')
    .split(':')
    .map(Number);

  if (now.hour() !== tHour || now.minute() !== tMinute) return;

  const targetDate = getNextBusinessSummaryDateString();
  const summaryKey = `redmine:summary:whatsapp:${targetDate}`;

  if (await wasAlreadyNotified(summaryKey)) return;

  try {
    const issueSummaries = await fetchIssuesByDate(targetDate);

    for (const issueSummary of issueSummaries) {
      try {
        const issue = await fetchIssueDetails(issueSummary.id);

        if (!isStrictMeetStatus(issue)) continue;

        const appointment = parseAppointmentDateTime(issue);

        if (!appointment) continue;

        const waGroupId = await getWhatsAppGroupId(issue);

        if (!waGroupId || !waSocket) continue;

        let groupJid = String(waGroupId).trim();

        if (!groupJid.includes('@')) {
          groupJid = `${groupJid}@g.us`;
        }

        await waSocket.sendMessage(groupJid, {
          text: buildClientSummaryMessage(issue, appointment.timeLabel)
        });

        console.log(`Resumo WhatsApp enviado para tarefa #${issue.id}`);
      } catch (err) {
        console.error(
          `Erro no resumo WhatsApp da tarefa #${issueSummary.id}:`,
          err.response?.data || err.message
        );
      }
    }

    await markAsNotified(summaryKey);
  } catch (error) {
    console.error(
      'Erro geral no resumo WhatsApp:',
      error.response?.data || error.message
    );
  }
}

// ---------------------------------------------------------
// EXPRESS
// ---------------------------------------------------------
const app = express();

app.use(express.json());

app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'OK',
    whatsappConnected: !!waSocket,
    redisConnected: !!redis,
    pollingEnabled: POLLING_ENABLED,
    notifyStatuses: NOTIFY_STATUSES,
    meetStatusName: MEET_STATUS_NAME
  });
});

app.get('/debug-alerts/:id', async (req, res) => {
  try {
    const issue = await fetchIssueDetails(req.params.id);
    const appointment = parseAppointmentDateTime(issue);
    const waGroupId = await getWhatsAppGroupId(issue);

    res.json({
      issue: issue.id,
      status: issue.status?.name,
      date: issue.start_date || issue.due_date,
      horario: appointment?.timeLabel || null,
      dataCompleta: appointment?.dateTime || null,
      grupoWhatsapp: waGroupId,
      googleMeet: getCustomFieldValue(issue, 'Google Meet')
    });
  } catch (err) {
    res.status(500).json({
      erro: err.response?.data || err.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor rodando com sucesso na porta ${PORT}`);

  pollingRedmineIssues();
  pollingAppointmentAlerts();
  processDailySummary();
  processClientMorningSummary();
  processMeetRecordings();

  setInterval(
    pollingRedmineIssues,
    Number(POLLING_INTERVAL_SECONDS) * 1000
  );

  setInterval(
    pollingAppointmentAlerts,
    Number(ALERT_POLLING_INTERVAL_SECONDS) * 1000
  );

  setInterval(processDailySummary, 60 * 1000);

  setInterval(processClientMorningSummary, 60 * 1000);

  setInterval(processMeetRecordings, 5 * 60 * 1000);
});