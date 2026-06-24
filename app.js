require('dotenv').config();

const express = require('express');
const axios = require('axios');
const Redis = require('ioredis');
const path = require('path');
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
  CLIENT_SUMMARY_TIME = '08:30',

  NOTIFY_STATUSES = 'Novo,Reaberta',
  MEET_STATUS_NAME = 'Aguardando Data',

  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REFRESH_TOKEN,
  GOOGLE_CALENDAR_ID,

  GOOGLE_DRIVE_CLIENTES_FOLDER_ID,
  GOOGLE_DRIVE_RECORDINGS_FOLDER_ID,
  GOOGLE_MEET_PROJECT_FIELD_NAME = 'Nome Fantasia',

  WHATSAPP_GROUP_FIELD_NAME = 'ID Grupo WhatsApp',
  WHATSAPP_AUTH_DIR,
  WHATSAPP_DEBUG_LOGS = 'true',

  ERROR_NOTIFICATION_ENABLED = 'true',
  ERROR_NOTIFICATION_WEBHOOK_URL,
  ERROR_NOTIFICATION_WHATSAPP_GROUP_ID,
  ERROR_NOTIFICATION_MIN_INTERVAL_SECONDS = 300
} = process.env;

const TZ = 'America/Sao_Paulo';
const WA_AUTH_DIR = WHATSAPP_AUTH_DIR || path.join(__dirname, '.wwebjs_auth');

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
let waConnected = false;
let waConnectionState = 'not_started';
let waLastQrAt = null;
let waLastError = null;
let waInitializing = false;
let waReconnectTimer = null;

function describeError(err) {
  return err?.response?.data || err?.message || err || null;
}

function whatsappDebugEnabled() {
  return WHATSAPP_DEBUG_LOGS === 'true';
}

function logWhatsAppDebug(message, details = null) {
  if (!whatsappDebugEnabled()) return;

  if (details) {
    console.log(message, details);
    return;
  }

  console.log(message);
}

function getWhatsAppRuntimeStatus() {
  return {
    connected: waConnected,
    connectionState: waConnectionState,
    hasSocket: Boolean(waSocket),
    lastQrAt: waLastQrAt,
    lastError: waLastError,
    authDir: WA_AUTH_DIR
  };
}

function unwrapWhatsAppMessage(message) {
  let current = message;

  while (
    current?.ephemeralMessage?.message ||
    current?.viewOnceMessage?.message ||
    current?.viewOnceMessageV2?.message ||
    current?.documentWithCaptionMessage?.message
  ) {
    current =
      current.ephemeralMessage?.message ||
      current.viewOnceMessage?.message ||
      current.viewOnceMessageV2?.message ||
      current.documentWithCaptionMessage?.message;
  }

  return current || {};
}

function getWhatsAppMessageText(message) {
  const content = unwrapWhatsAppMessage(message);

  return (
    content.conversation ||
    content.extendedTextMessage?.text ||
    content.imageMessage?.caption ||
    content.videoMessage?.caption ||
    content.documentMessage?.caption ||
    content.buttonsResponseMessage?.selectedButtonId ||
    content.listResponseMessage?.singleSelectReply?.selectedRowId ||
    content.templateButtonReplyMessage?.selectedId ||
    ''
  );
}

function scheduleWhatsAppReconnect(reason) {
  if (waReconnectTimer) return;

  console.log(`WhatsApp: reconexão agendada em 15s${reason ? ` (${reason})` : ''}.`);

  waReconnectTimer = setTimeout(() => {
    waReconnectTimer = null;
    initWhatsApp();
  }, 15000);
}

async function initWhatsApp() {
  if (waInitializing) return;

  waInitializing = true;
  waConnected = false;
  waConnectionState = 'starting';

  try {
    console.log(`WhatsApp: inicializando sessão em ${WA_AUTH_DIR}`);

    const { state, saveCreds } = await useMultiFileAuthState(WA_AUTH_DIR);

    waSocket = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
      browser: ['Bot NewNorte', 'Chrome', '1.0.0']
    });

    waSocket.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        waLastQrAt = new Date().toISOString();
        console.log('--- NOVO QR CODE GERADO ---');
        qrcode.generate(qr, { small: true });
      }

      if (connection) {
        waConnectionState = connection;
        logWhatsAppDebug(`WhatsApp: connection.update = ${connection}`);
      }

      if (connection === 'close') {
        waConnected = false;
        waSocket = null;

        const statusCode = lastDisconnect?.error?.output?.statusCode;
        waLastError = describeError(lastDisconnect?.error);

        console.log(
          `WhatsApp: conexão fechada${statusCode ? ` (status ${statusCode})` : ''}.`,
          waLastError || ''
        );

        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        if (shouldReconnect) {
          scheduleWhatsAppReconnect(`status ${statusCode || 'desconhecido'}`);
        } else {
          console.log('WhatsApp: sessão deslogada. Leia o novo QR Code para reconectar.');
          notifyAttention(
            'whatsapp_logged_out',
            'WhatsApp deslogado: precisa ler um novo QR Code',
            { statusCode, error: waLastError }
          );
        }
      }

      if (connection === 'open') {
        waConnected = true;
        waLastError = null;
        console.log('WhatsApp conectado com sucesso!');
      }
    });

    waSocket.ev.on('creds.update', saveCreds);

    waSocket.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const msg of messages) {
        if (!msg.message) continue;

        const text = getWhatsAppMessageText(msg.message);
        const from = msg.key.remoteJid;

        logWhatsAppDebug('WhatsApp: mensagem recebida', {
          from,
          participant: msg.key.participant || null,
          fromMe: Boolean(msg.key.fromMe),
          text
        });

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
            console.error('Erro ao responder !id:', describeError(err));
          }
        }
      }
    });
  } catch (err) {
    waSocket = null;
    waConnected = false;
    waConnectionState = 'error';
    waLastError = describeError(err);

    console.error('Erro ao inicializar WhatsApp:', waLastError);
    await notifyAttention(
      'whatsapp_init_error',
      'Erro ao inicializar WhatsApp',
      waLastError
    );
    scheduleWhatsAppReconnect('erro na inicialização');
  } finally {
    waInitializing = false;
  }
}

// ---------------------------------------------------------
// REDIS / CACHE LOCAL
// ---------------------------------------------------------
const redis = new Redis(REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  lazyConnect: true
});

const memory = {
  values: new Map(),
  meetIssues: new Set(),
  notified: new Set(),
  alerts: new Set(),
  completedAppointments: new Set(),
  attentionNotifications: new Map()
};

function compactDetails(details) {
  if (!details) return null;

  const value = typeof details === 'string'
    ? details
    : JSON.stringify(details, null, 2);

  return value.length > 1200 ? `${value.slice(0, 1200)}...` : value;
}

async function notifyAttention(key, title, details = null) {
  if (ERROR_NOTIFICATION_ENABLED !== 'true') return;

  const throttleMs = Number(ERROR_NOTIFICATION_MIN_INTERVAL_SECONDS || 300) * 1000;
  const now = Date.now();
  const lastSentAt = memory.attentionNotifications.get(key) || 0;

  if (now - lastSentAt < throttleMs) return;

  memory.attentionNotifications.set(key, now);

  const detailsText = compactDetails(details);
  const message = [
    `⚠️ Atenção necessária no bot Redmine`,
    `*${title}*`,
    `Horário: ${dayjs().tz(TZ).format('YYYY-MM-DD HH:mm:ss')}`,
    detailsText ? `Detalhes:\n${detailsText}` : null
  ]
    .filter(Boolean)
    .join('\n\n');

  if (ERROR_NOTIFICATION_WEBHOOK_URL) {
    try {
      await axios.post(ERROR_NOTIFICATION_WEBHOOK_URL, { text: message });
    } catch (err) {
      console.error('Erro ao notificar atenção por webhook:', describeError(err));
    }
  }

  if (ERROR_NOTIFICATION_WHATSAPP_GROUP_ID) {
    try {
      const groupJid = normalizeWhatsAppGroupJid(ERROR_NOTIFICATION_WHATSAPP_GROUP_ID);

      if (groupJid && waSocket && waConnected) {
        await waSocket.sendMessage(groupJid, { text: message });
      }
    } catch (err) {
      console.error('Erro ao notificar atenção por WhatsApp:', describeError(err));
    }
  }
}

if (redis) {
  redis.on('error', (err) => {
    console.error('Erro no Redis:', describeError(err));
    notifyAttention('redis_error', 'Erro de conexão/operação no Redis', describeError(err));
  });
}

initWhatsApp();

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
  if (redis) return (await redis.get(key)) !== null;
  return memory.notified.has(key);
}

async function getNotificationMarker(key) {
  const value = redis
    ? await redis.get(key)
    : memory.values.get(key) || (memory.notified.has(key) ? '1' : null);

  if (!value) return null;

  try {
    const parsed = JSON.parse(value);

    if (parsed && typeof parsed === 'object') {
      return parsed;
    }

    return { value };
  } catch (_) {
    return { value };
  }
}

async function clearNotificationMarker(key) {
  if (redis) {
    await redis.del(key);
    return;
  }

  memory.values.delete(key);
  memory.notified.delete(key);
}

async function markAsNotified(key, metadata = null) {
  const ttl = Number(REDIS_TTL_DAYS) * 86400;
  const value = metadata
    ? JSON.stringify({
        ...metadata,
        markedAt: dayjs().tz(TZ).format('YYYY-MM-DD HH:mm:ss')
      })
    : '1';

  if (redis) {
    await redis.set(key, value, 'EX', ttl);
    return;
  }

  memory.notified.add(key);
  memory.values.set(key, value);
  setTimeout(() => memory.notified.delete(key), ttl * 1000);
  setTimeout(() => memory.values.delete(key), ttl * 1000);
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

async function wasAppointmentCompleted(key) {
  return memory.completedAppointments.has(key);
}

async function markAppointmentCompleted(key) {
  const ttl = 36 * 60 * 60;

  memory.completedAppointments.add(key);
  setTimeout(() => memory.completedAppointments.delete(key), ttl * 1000);
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

function getAppointmentDate(issue, preferredDate = null) {
  const startDate = issue.start_date || null;
  const dueDate = issue.due_date || null;

  if (preferredDate && (dueDate === preferredDate || startDate === preferredDate)) {
    return preferredDate;
  }

  return dueDate || startDate || null;
}

function parseAppointmentDateTime(issue, preferredDate = null) {
  const date = getAppointmentDate(issue, preferredDate);
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
    date,
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

  if (isWeekendDate(now)) return false;

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

function isWeekendDate(date) {
  const day = date.day();
  return day === 0 || day === 6;
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
    await notifyAttention(
      `redmine_project_error:${projectId}`,
      'Erro ao buscar projeto no Redmine',
      { projectId, error: err.response?.data || err.message }
    );
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

function normalizeWhatsAppGroupJid(groupId) {
  if (!groupId) return null;

  const groupJid = String(groupId).trim();

  if (!groupJid) return null;

  if (groupJid.includes('@')) {
    return groupJid;
  }

  return `${groupJid}@g.us`;
}

async function sendWhatsAppText(groupId, text, contextLabel) {
  const groupJid = normalizeWhatsAppGroupJid(groupId);

  if (!groupJid) {
    console.log(`WhatsApp ${contextLabel}: grupo não informado.`);
    return { sent: false, reason: 'missing_group' };
  }

  if (!waSocket) {
    console.log(`WhatsApp ${contextLabel}: socket não inicializado.`, getWhatsAppRuntimeStatus());
    await notifyAttention(
      'whatsapp_missing_socket',
      'WhatsApp sem socket inicializado',
      { contextLabel, whatsapp: getWhatsAppRuntimeStatus() }
    );
    return { sent: false, reason: 'missing_socket' };
  }

  if (!waConnected) {
    console.log(`WhatsApp ${contextLabel}: conexão não está aberta.`, getWhatsAppRuntimeStatus());
    await notifyAttention(
      'whatsapp_not_connected',
      'WhatsApp desconectado',
      { contextLabel, whatsapp: getWhatsAppRuntimeStatus() }
    );
    return { sent: false, reason: 'not_connected' };
  }

  try {
    await waSocket.sendMessage(groupJid, { text });
    console.log(`WhatsApp ${contextLabel}: mensagem enviada para ${groupJid}`);
    return { sent: true, groupJid };
  } catch (err) {
    console.error(`WhatsApp ${contextLabel}: erro ao enviar para ${groupJid}:`, describeError(err));
    await notifyAttention(
      `whatsapp_send_error:${groupJid}`,
      'Erro ao enviar mensagem pelo WhatsApp',
      { contextLabel, groupJid, error: describeError(err) }
    );
    return { sent: false, reason: 'send_error', error: describeError(err), groupJid };
  }
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
        await notifyAttention(
          `mattermost_send_error:${target.email}`,
          'Erro ao enviar mensagem pelo Mattermost',
          { target: target.email, error: error.response?.data || error.message }
        );
      }
    }
  } catch (err) {
    console.error('Erro geral no Mattermost:', err.response?.data || err.message);
    await notifyAttention(
      'mattermost_general_error',
      'Erro geral no Mattermost',
      err.response?.data || err.message
    );
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

function buildClientSummaryMessage(issue, timeLabel, preferredDate = null) {
  const meetLink = getCustomFieldValue(issue, 'Google Meet');
  const publicoAlvoRaw = getCustomFieldValue(issue, 'Público Alvo');
  const appointmentDate = getAppointmentDate(issue, preferredDate);

  let publicoAlvo = '';

  if (publicoAlvoRaw) {
    publicoAlvo = Array.isArray(publicoAlvoRaw)
      ? publicoAlvoRaw
          .map(v => (typeof v === 'object' ? v.value || v.name : v))
          .join(' / ')
      : String(publicoAlvoRaw).trim();
  }

  let msg = `📅 *Confirmação de Compromisso*\n\n`;
  msg += `Olá! Passando para lembrar do seu compromisso agendado para o próximo dia útil (${dayjs(appointmentDate).format('DD/MM/YYYY')}).\n\n`;
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
const APPOINTMENT_ALERT_LOOKAHEAD_SECONDS = 12 * 60;
const APPOINTMENT_ALERT_STOP_BEFORE_SECONDS = 60;

function incrementAlertStat(stats, key) {
  if (!stats) return;
  stats[key] = (stats[key] || 0) + 1;
}

async function checkAppointmentAlert(issue, preferredDate = null, stats = null) {
  if (!isStrictMeetStatus(issue)) {
    incrementAlertStat(stats, 'skippedStatus');
    return 'skipped_status';
  }

  const appointment = parseAppointmentDateTime(issue, preferredDate);

  if (!appointment) {
    incrementAlertStat(stats, 'invalidAppointment');
    return 'invalid_appointment';
  }

  const agora = dayjs().tz(TZ);
  const dataAgendamento = dayjs(appointment.dateTime).tz(TZ);

  const diffSegundos = dataAgendamento.diff(agora, 'second');

  if (diffSegundos > APPOINTMENT_ALERT_LOOKAHEAD_SECONDS) {
    incrementAlertStat(stats, 'tooEarly');
    return 'too_early';
  }

  if (diffSegundos < APPOINTMENT_ALERT_STOP_BEFORE_SECONDS) {
    incrementAlertStat(stats, 'pastOrTooLate');
    return 'past_or_too_late';
  }

  const windowSeconds = Number(ALERT_WINDOW_SECONDS || 180);

  const mmMin1 = Number(ALERT_MINUTES_BEFORE || 10);
  const mmMin2 = Number(ALERT_EXTRA_MINUTES_BEFORE || 2);
  const waMin = Number(WHATSAPP_ALERT_MINUTES_BEFORE || 5);

  const appointmentKey = dataAgendamento.format('YYYYMMDDHHmm');

  console.log(
    `Verificando alerta #${issue.id} | ${appointment.date} ${appointment.timeLabel} | Faltam ${diffSegundos}s`
  );
  incrementAlertStat(stats, 'checkedWindow');

  async function sendMattermostAlert(minutes) {
    const targetSec = minutes * 60;
    const lowerBoundSeconds = Math.max(
      APPOINTMENT_ALERT_STOP_BEFORE_SECONDS,
      targetSec - windowSeconds
    );

    if (
      diffSegundos <= targetSec &&
      diffSegundos >= lowerBoundSeconds
    ) {
      const alertKey = `redmine:mm:${issue.id}:${appointmentKey}:${minutes}`;

      if (await wasAppointmentAlertSent(alertKey)) {
        incrementAlertStat(stats, 'alreadySent');
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
      incrementAlertStat(stats, 'sentMattermost');

      console.log(`Mattermost enviado (${minutes} min) para tarefa #${issue.id}`);
    }
  }

  async function sendWhatsAppAlert(minutes) {
    const targetSec = minutes * 60;
    const lowerBoundSeconds = Math.max(
      APPOINTMENT_ALERT_STOP_BEFORE_SECONDS,
      targetSec - windowSeconds
    );

    if (
      diffSegundos <= targetSec &&
      diffSegundos >= lowerBoundSeconds
    ) {
      const alertKey = `redmine:wa:${issue.id}:${appointmentKey}:${minutes}`;

      if (await wasAppointmentAlertSent(alertKey)) {
        incrementAlertStat(stats, 'alreadySent');
        return;
      }

      const waGroupId = await getWhatsAppGroupId(issue);

      if (!waGroupId) {
        console.log(`Tarefa #${issue.id} sem grupo WhatsApp.`);
        await notifyAttention(
          `appointment_missing_whatsapp_group:${issue.id}`,
          'Tarefa sem grupo WhatsApp para alerta',
          {
            issueId: issue.id,
            project: issue.project?.name || null,
            fieldName: WHATSAPP_GROUP_FIELD_NAME
          }
        );
        return;
      }

      const result = await sendWhatsAppText(
        waGroupId,
        buildWhatsAppMessage(issue, minutes, appointment.timeLabel),
        `alerta #${issue.id} (${minutes} min)`
      );

      if (!result.sent) return;

      await markAppointmentAlertSent(alertKey);
      incrementAlertStat(stats, 'sentWhatsapp');
      console.log(`WhatsApp enviado (${minutes} min) para tarefa #${issue.id}`);
    }
  }

  await sendMattermostAlert(mmMin1);
  await sendWhatsAppAlert(waMin);
  await sendMattermostAlert(mmMin2);

  return 'checked';
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
    await notifyAttention(
      `meet_delete_error:${issueId}`,
      'Erro ao excluir evento do Google Meet',
      { issueId, error: error.response?.data || error.message }
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
    const hasKnownMeet =
      await redisGet(`redmine:meet:event:${issue.id}`) ||
      await redisGet(`redmine:meet:link:${issue.id}`) ||
      getCustomFieldValue(issue, 'Google Meet');

    if (hasKnownMeet) {
      console.log(`[MEET] Removendo Meet inválido da tarefa #${issue.id}`);
      await deleteGoogleMeet(issue.id);
    }

    return;
  }

  const startDate = appointment.dateTime;
  const endDate = new Date(startDate.getTime() + estimatedMinutes * 60000);

  const projectName = await getMeetProjectName(issue);

  await getOrCreateClientFolderStructure(issue).catch(() => {});

  const summary =
    `#${issue.id} - ${projectName} - ${issue.subject} - ${appointment.timeLabel}`;

  const signature = JSON.stringify({
    summary,
    start: startDate.toISOString(),
    end: endDate.toISOString()
  });

  const signatureKey = `redmine:meet:signature:${issue.id}`;
  const oldSignature = await redisGet(signatureKey);

  let eventId = await redisGet(`redmine:meet:event:${issue.id}`);

  // Otimização: se já existe evento salvo e a assinatura não mudou,
  // não consulta o Google Calendar novamente.
  if (eventId && oldSignature === signature) {
    const meetLink = await redisGet(`redmine:meet:link:${issue.id}`);

    if (
      meetLink &&
      getCustomFieldValue(issue, 'Google Meet') !== meetLink
    ) {
      await updateRedmineCustomField(issue, 'Google Meet', meetLink);
      console.log(`Campo Google Meet restaurado na tarefa #${issue.id}`);
    }

    return;
  }

  const calendar = getGoogleCalendarClient();
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
      console.log(`Google Meet atualizado para tarefa #${issue.id}`);

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
      console.log(`Google Meet criado para tarefa #${issue.id}`);
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

    await notifyAttention(
      `meet_sync_error:${issue.id}`,
      'Erro ao sincronizar Google Meet',
      { issueId: issue.id, error: error.response?.data || error.message }
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
    fields: 'files(id, name, mimeType, parents, webViewLink, videoMediaMetadata(durationMillis))'
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
    await notifyAttention(
      `drive_structure_error:${issue?.project?.id || 'unknown'}`,
      'Erro ao criar estrutura no Google Drive',
      { issueId: issue?.id, projectId: issue?.project?.id, error: err.response?.data || err.message }
    );
    return null;
  }
}
function formatDurationFromMillis(durationMillis) {
  if (!durationMillis) return 'não informado';

  const totalSeconds = Math.round(Number(durationMillis) / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, '0')}min ${String(seconds).padStart(2, '0')}s`;
  }

  return `${minutes}min ${String(seconds).padStart(2, '0')}s`;
}

async function addRedmineJournalNote(issueId, note) {
  await axios.put(
    `${REDMINE_URL}/issues/${issueId}.json`,
    {
      issue: {
        notes: note
      }
    },
    { headers: redmineHeaders }
  );

  console.log(`[REDMINE] Journal criado na tarefa #${issueId}`);
}
async function processMeetRecordings() {
  if (!GOOGLE_DRIVE_RECORDINGS_FOLDER_ID || !googleCalendarIsConfigured()) {
    // Log detalhado removido: essa rotina roda a cada 5 minutos.
    return;
  }

  try {
    const drive = getGoogleDriveClient();

    // Log detalhado removido:
    // console.log('[DRIVE] Verificando pasta de gravações:', GOOGLE_DRIVE_RECORDINGS_FOLDER_ID);

    const res = await drive.files.list({
      q: `'${GOOGLE_DRIVE_RECORDINGS_FOLDER_ID}' in parents and trashed = false`,
      fields: 'files(id, name, parents, webViewLink, videoMediaMetadata(durationMillis))'
    });

    const files = res.data.files || [];

    // Log detalhado removido:
    // console.log('[DRIVE] Arquivos encontrados:', files.map(f => ({ id: f.id, name: f.name })));

    for (const file of files) {
      const match = file.name.match(/#(\d+)/);

      if (!match) {
        // Log detalhado removido para evitar ruído com arquivos sem identificação.
        // console.log(`[DRIVE] Ignorado sem número da tarefa no nome: ${file.name}`);
        continue;
      }

      const issueId = match[1];

      const isVideo =
  file.mimeType?.startsWith('video/') ||
  Boolean(file.videoMediaMetadata?.durationMillis);

if (!isVideo) {
  console.log(`[DRIVE] Arquivo movido sem journal, pois não é vídeo: ${file.name}`);
}

      try {
        const issue = await fetchIssueDetails(issueId);
        const structure = await getOrCreateClientFolderStructure(issue);

        if (!structure?.treinamentosFolderId) {
          console.log(`[DRIVE] Não moveu #${issueId}: estrutura/pasta Treinamentos não criada.`);
          continue;
        }

        await drive.files.update({
          fileId: file.id,
          addParents: structure.treinamentosFolderId,
          removeParents: GOOGLE_DRIVE_RECORDINGS_FOLDER_ID,
          fields: 'id, parents'
        });

        console.log(`[DRIVE] Arquivo movido com sucesso: ${file.name} → Treinamentos`);

        const durationText = formatDurationFromMillis(
          file.videoMediaMetadata?.durationMillis
        );

        const isVideo =
  file.mimeType?.startsWith('video/') ||
  Boolean(file.videoMediaMetadata?.durationMillis);

if (isVideo) {
  const durationText = formatDurationFromMillis(
    file.videoMediaMetadata?.durationMillis
  );

  const note = [
    `Gravação do Google Meet movida para a pasta Treinamentos.`,
    ``,
    `Arquivo: ${file.name}`,
    `Duração do vídeo: ${durationText}`,
    file.webViewLink ? `Link do arquivo: ${file.webViewLink}` : null
  ].filter(Boolean).join('\n');

  await addRedmineJournalNote(issueId, note);
}

      } catch (err) {
        console.error(`[DRIVE] Erro ao mover ${file.name}:`, err.response?.data || err.message);
      }
    }
  } catch (error) {
    console.error('[DRIVE] Erro geral:', error.response?.data || error.message);
  }
}

// ---------------------------------------------------------
// POLLING REDMINE
// ---------------------------------------------------------
let lastPollingTimestamp = Date.now() - 10 * 60 * 1000;
// Pequena sobreposição para não perder atualizações na borda de segundo/minuto
// sem precisar aumentar muito o volume de leitura.
const POLLING_LOOKBACK_MS = 3000;

function getNextPollingTimestamp(previousTimestamp, pollStartedAt, maxUpdatedAt = null) {
  const baseTimestamp = maxUpdatedAt ?? pollStartedAt;
  const nextTimestamp = baseTimestamp - POLLING_LOOKBACK_MS;

  return Math.max(previousTimestamp, nextTimestamp);
}

async function fetchRecentIssuesPage(offset = 0, limit = Number(POLLING_LIMIT)) {
  const response = await axios.get(`${REDMINE_URL}/issues.json`, {
    headers: redmineHeaders,
    params: {
      status_id: '*',
      sort: 'updated_on:desc',
      limit,
      offset
    }
  });

  return response.data.issues || [];
}

async function fetchRecentIssuesSince(timestamp) {
  const issues = [];
  const pageLimit = Math.max(Number(POLLING_LIMIT) || 20, 100);
  const threshold = Math.max(0, timestamp - POLLING_LOOKBACK_MS);
  let maxUpdatedAt = null;

  for (let offset = 0; ; offset += pageLimit) {
    const page = await fetchRecentIssuesPage(offset, pageLimit);

    if (!page.length) break;

    for (const issueSummary of page) {
      const updatedAt = new Date(issueSummary.updated_on).getTime();

      if (!Number.isNaN(updatedAt)) {
        maxUpdatedAt = maxUpdatedAt === null ? updatedAt : Math.max(maxUpdatedAt, updatedAt);
      }

      if (updatedAt < threshold) {
        return { issues, maxUpdatedAt };
      }

      issues.push(issueSummary);
    }

    if (page.length < pageLimit) break;
  }

  return { issues, maxUpdatedAt };
}

async function backfillGoogleMeetIssues() {
  if (!googleCalendarIsConfigured()) return;

  const issues = [];
  const pageLimit = Math.max(Number(POLLING_LIMIT) || 20, 100);

  for (let offset = 0; ; offset += pageLimit) {
    const page = await fetchRecentIssuesPage(offset, pageLimit);

    if (!page.length) break;

  issues.push(
  ...page.filter(issueSummary => {
    if (!isStrictMeetStatus(issueSummary)) return false;

    const date = issueSummary.start_date || issueSummary.due_date;
    if (!date) return false;

    const today = dayjs().tz(TZ).format('YYYY-MM-DD');

    return date >= today;
  })
);

    if (page.length < pageLimit) break;
  }

  for (const issueSummary of issues) {
    try {
      const issue = await fetchIssueDetails(issueSummary.id);
      const signatureKey = `redmine:meet:signature:${issue.id}`;
      const eventKey = `redmine:meet:event:${issue.id}`;
      const meetLink = getCustomFieldValue(issue, 'Google Meet');

      if (
        meetLink &&
        (await redisGet(signatureKey)) &&
        (await redisGet(eventKey))
      ) {
        continue;
      }

      const issueWithUrl = {
        ...issue,
        url: `${REDMINE_URL}/issues/${issue.id}`
      };

      await processGoogleMeet(issueWithUrl);
    } catch (err) {
      console.error(
        `Erro no backfill do Meet para a tarefa #${issueSummary.id}:`,
        err.response?.data || err.message
      );
      await notifyAttention(
        `meet_backfill_error:${issueSummary.id}`,
        'Erro no backfill do Google Meet',
        { issueId: issueSummary.id, error: err.response?.data || err.message }
      );
    }
  }
}

async function pollingRedmineIssues() {
  if (POLLING_ENABLED !== 'true') {
    console.log('[POLLING] Ignorado: POLLING_ENABLED não está true.');
    return;
  }

  const startedAt = Date.now();
  const stats = {
    fetched: 0,
    processed: 0,
    errors: 0
  };

  try {
    const limit = Math.max(Number(POLLING_LIMIT) || 20, 100);
    const issues = await fetchRecentIssuesPage(0, limit);

    stats.fetched = issues.length;

    // Logs detalhados removidos para reduzir ruído:
    // console.log('[POLLING] Tarefas retornadas pelo Redmine:', issues.map(...));

    for (const issueSummary of issues) {
      try {
        const issue = await fetchIssueDetails(issueSummary.id);

        const issueWithUrl = {
          ...issue,
          url: `${REDMINE_URL}/issues/${issue.id}`
        };

        stats.processed += 1;

        // Log detalhado removido para evitar excesso:
        // console.log(`[POLLING] Processando tarefa #${issue.id}`, {...});

        await processGoogleMeet(issueWithUrl);

        const lastJournal = getLastJournal(issueWithUrl);

        // Diagnóstico removido após validação:
        // const eventKey = getEventKey(issueWithUrl, 'Polling', lastJournal);
        // const alreadyNotified = await wasAlreadyNotified(eventKey);
        // console.log(`[NOTIFY] Diagnóstico #${issue.id}`, {...});

        await processIssueNotification(
          issueWithUrl,
          'Atualização',
          'Polling',
          lastJournal
        );

      } catch (err) {
        stats.errors += 1;

        if (err.response?.status === 404) {
          await deleteGoogleMeet(issueSummary.id);
        } else {
          console.error(
            `Erro no polling da tarefa #${issueSummary.id}:`,
            err.response?.data || err.message
          );

          await notifyAttention(
            `polling_issue_error:${issueSummary.id}`,
            'Erro no polling de tarefa do Redmine',
            {
              issueId: issueSummary.id,
              error: err.response?.data || err.message
            }
          );
        }
      }
    }

    if (stats.errors > 0) {
      console.log(
        `[POLLING] Concluído com erro(s): buscadas=${stats.fetched}, processadas=${stats.processed}, erros=${stats.errors}, tempoMs=${Date.now() - startedAt}`
      );
    }
  } catch (error) {
    console.error(
      'Erro geral no polling:',
      error.response?.data || error.message
    );

    await notifyAttention(
      'polling_general_error',
      'Erro geral no polling do Redmine',
      error.response?.data || error.message
    );
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
      fetchByField('start_date').catch(async (error) => {
        await notifyAttention(
          `redmine_fetch_by_date_error:start_date:${dateStr}`,
          'Erro ao buscar tarefas por data no Redmine',
          { field: 'start_date', date: dateStr, error: error.response?.data || error.message }
        );
        return [];
      }),
      fetchByField('due_date').catch(async (error) => {
        await notifyAttention(
          `redmine_fetch_by_date_error:due_date:${dateStr}`,
          'Erro ao buscar tarefas por data no Redmine',
          { field: 'due_date', date: dateStr, error: error.response?.data || error.message }
        );
        return [];
      })
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
    await notifyAttention(
      `redmine_fetch_by_date_general_error:${dateStr}`,
      'Erro geral ao buscar tarefas por data no Redmine',
      { date: dateStr, error: error.response?.data || error.message }
    );

    return [];
  }
}

async function pollingAppointmentAlerts() {
  try {
    const today = dayjs().tz(TZ).format('YYYY-MM-DD');
    const stats = {
      found: 0,
      fetchedDetails: 0,
      skippedStatus: 0,
      invalidAppointment: 0,
      tooEarly: 0,
      pastOrTooLate: 0,
      skippedCompleted: 0,
      checkedWindow: 0,
      alreadySent: 0,
      sentMattermost: 0,
      sentWhatsapp: 0,
      errors: 0
    };

    const issues = await fetchIssuesByDate(today);
    stats.found = issues.length;

    for (const issueSummary of issues) {
      try {
        if (issueSummary.status && !isStrictMeetStatus(issueSummary)) {
          stats.skippedStatus += 1;
          continue;
        }

        const completedKey = `redmine:appointment:completed:${today}:${issueSummary.id}`;

        if (await wasAppointmentCompleted(completedKey)) {
          stats.skippedCompleted += 1;
          continue;
        }

        const issue = await fetchIssueDetails(issueSummary.id);
        stats.fetchedDetails += 1;

        const issueWithUrl = {
          ...issue,
          url: `${REDMINE_URL}/issues/${issue.id}`
        };

        const result = await checkAppointmentAlert(issueWithUrl, today, stats);

        if (result === 'past_or_too_late') {
          await markAppointmentCompleted(completedKey);
        }
      } catch (err) {
        stats.errors += 1;
        console.error(
          `Erro ao verificar alerta da tarefa #${issueSummary.id}:`,
          err.response?.data || err.message
        );
        await notifyAttention(
          `appointment_alert_issue_error:${issueSummary.id}`,
          'Erro ao verificar alerta de compromisso',
          { issueId: issueSummary.id, error: err.response?.data || err.message }
        );
      }
    }

    logWhatsAppDebug(`[Alertas] Resumo ${today}:`, stats);
  } catch (error) {
    console.error(
      'Erro geral no polling de alertas:',
      error.response?.data || error.message
    );
    await notifyAttention(
      'appointment_alerts_general_error',
      'Erro geral no polling de alertas',
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

      const appointment = parseAppointmentDateTime(issue, targetDate);

      if (!appointment) continue;

      const targets = await getResponsibleTargets(issue);

      if (!targets.length) continue;

      const projectName = await getMeetProjectName(issue);
      const meetLink = getCustomFieldValue(issue, 'Google Meet');

      const sortKey = `${appointment.date || ''} ${appointment.timeLabel}`;

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
    await notifyAttention(
      `daily_summary_mattermost_error:${targetDate}`,
      'Erro no resumo diário do Mattermost',
      { targetDate, error: error.response?.data || error.message }
    );
  }
}

// ---------------------------------------------------------
// RESUMO WHATSAPP CLIENTE
// ---------------------------------------------------------
async function processClientMorningSummary(options = {}) {
  const force = options.force === true;
  const dryRun = options.dryRun === true;
  const resetNotified = options.resetNotified === true;
  const source = options.source || 'scheduler';
  const now = dayjs().tz(TZ);
  const [tHour, tMinute] = String(CLIENT_SUMMARY_TIME || '08:30')
    .split(':')
    .map(Number);
  const targetTime = `${String(tHour).padStart(2, '0')}:${String(tMinute).padStart(2, '0')}`;
  const result = {
    source,
    force,
    dryRun,
    resetNotified,
    enabled: CLIENT_SUMMARY_ENABLED === 'true',
    now: now.format('YYYY-MM-DD HH:mm:ss'),
    targetTime,
    targetDate: null,
    summaryKey: null,
    alreadyNotified: false,
    notifiedMarker: null,
    markedNotified: false,
    clearedNotified: false,
    reason: null,
    counts: {
      found: 0,
      eligible: 0,
      sent: 0,
      failed: 0,
      skipped: 0
    },
    sent: [],
    failed: [],
    skipped: [],
    whatsapp: getWhatsAppRuntimeStatus()
  };

  if (CLIENT_SUMMARY_ENABLED !== 'true' && !force) {
    result.reason = 'disabled';
    logWhatsAppDebug('[Resumo WhatsApp] Ignorado: CLIENT_SUMMARY_ENABLED não está true.');
    return result;
  }

  if (Number.isNaN(tHour) || Number.isNaN(tMinute)) {
    result.reason = 'invalid_time';
    console.error(`[Resumo WhatsApp] CLIENT_SUMMARY_TIME inválido: ${CLIENT_SUMMARY_TIME}`);
    await notifyAttention(
      'client_summary_invalid_time',
      'CLIENT_SUMMARY_TIME inválido',
      { value: CLIENT_SUMMARY_TIME }
    );
    return result;
  }

  if (!force && (now.hour() !== tHour || now.minute() !== tMinute)) {
    result.reason = 'outside_time';
    return result;
  }

  const targetDate = getNextBusinessSummaryDateString();
  const summaryKey = `redmine:summary:whatsapp:${targetDate}`;

  result.targetDate = targetDate;
  result.summaryKey = summaryKey;

  if (!force && isWeekendDate(now)) {
    result.reason = 'weekend';
    logWhatsAppDebug(
      `[Resumo WhatsApp] Ignorado no fim de semana. Compromissos de ${targetDate} são gerados no dia útil anterior.`
    );
    return result;
  }

  if (resetNotified) {
    await clearNotificationMarker(summaryKey);
    result.clearedNotified = true;
    console.log(`[Resumo WhatsApp] Chave removida para reprocessamento: ${summaryKey}`);
  }

  result.notifiedMarker = await getNotificationMarker(summaryKey);
  result.alreadyNotified = Boolean(result.notifiedMarker);

  if (result.alreadyNotified && !force) {
    result.reason = 'already_notified';
    logWhatsAppDebug(`[Resumo WhatsApp] Ignorado: ${summaryKey} já foi notificado.`);
    return result;
  }

  try {
    const issueSummaries = await fetchIssuesByDate(targetDate);

    result.counts.found = issueSummaries.length;

    console.log(
      `[Resumo WhatsApp] ${issueSummaries.length} tarefa(s) encontradas para ${targetDate}.`,
      issueSummaries.map(i => i.id)
    );

    for (const issueSummary of issueSummaries) {
      try {
        const issue = await fetchIssueDetails(issueSummary.id);
        const item = {
          id: issue.id,
          status: issue.status?.name || null,
          startDate: issue.start_date || null,
          dueDate: issue.due_date || null,
          timeValue: getCustomFieldValue(issue, ALERT_FIELD_NAME),
          groupId: null,
          reason: null
        };

        if (!isStrictMeetStatus(issue)) {
          item.reason = 'not_meet_status';
          result.skipped.push(item);
          result.counts.skipped += 1;
          logWhatsAppDebug(`[Resumo WhatsApp] Tarefa #${issue.id} ignorada: status "${item.status}".`);
          continue;
        }

        const appointment = parseAppointmentDateTime(issue, targetDate);

        if (!appointment) {
          item.reason = 'invalid_appointment';
          result.skipped.push(item);
          result.counts.skipped += 1;
          console.log('[Resumo WhatsApp] Tarefa ignorada: data/horário inválidos.', item);
          continue;
        }

        const waGroupId = await getWhatsAppGroupId(issue);
        item.groupId = waGroupId;
        item.appointmentDate = appointment.date;
        item.timeLabel = appointment.timeLabel;

        if (!waGroupId) {
          item.reason = 'missing_group';
          result.skipped.push(item);
          result.counts.skipped += 1;
          console.log(`[Resumo WhatsApp] Tarefa #${issue.id} sem grupo WhatsApp.`, item);
          await notifyAttention(
            `client_summary_missing_whatsapp_group:${issue.id}`,
            'Tarefa sem grupo WhatsApp para resumo',
            {
              issueId: issue.id,
              targetDate,
              project: issue.project?.name || null,
              fieldName: WHATSAPP_GROUP_FIELD_NAME
            }
          );
          continue;
        }

        result.counts.eligible += 1;

        if (dryRun) {
          item.reason = 'dry_run';
          result.skipped.push(item);
          result.counts.skipped += 1;
          console.log(`[Resumo WhatsApp] Dry-run: enviaria tarefa #${issue.id} para ${waGroupId}.`);
          continue;
        }

        const sendResult = await sendWhatsAppText(
          waGroupId,
          buildClientSummaryMessage(issue, appointment.timeLabel, targetDate),
          `resumo #${issue.id}`
        );

        if (sendResult.sent) {
          result.sent.push({
            ...item,
            groupJid: sendResult.groupJid
          });
          result.counts.sent += 1;
          continue;
        }

        result.failed.push({
          ...item,
          reason: sendResult.reason,
          error: sendResult.error || null,
          groupJid: sendResult.groupJid || null
        });
        result.counts.failed += 1;
      } catch (err) {
        console.error(
          `Erro no resumo WhatsApp da tarefa #${issueSummary.id}:`,
          describeError(err)
        );
        await notifyAttention(
          `client_summary_issue_error:${issueSummary.id}`,
          'Erro no resumo WhatsApp de uma tarefa',
          { issueId: issueSummary.id, error: describeError(err) }
        );

        result.failed.push({
          id: issueSummary.id,
          reason: 'exception',
          error: describeError(err)
        });
        result.counts.failed += 1;
      }
    }

    const blockingSkips = result.skipped.filter(item => item.reason === 'missing_group');

    if (!dryRun && result.counts.sent > 0 && result.counts.failed === 0 && blockingSkips.length === 0) {
      await markAsNotified(summaryKey, {
        type: 'client_summary_whatsapp',
        source,
        targetDate,
        sent: result.counts.sent,
        eligible: result.counts.eligible,
        found: result.counts.found
      });
      result.notifiedMarker = await getNotificationMarker(summaryKey);
      result.markedNotified = true;
      console.log(`[Resumo WhatsApp] Concluído e marcado como notificado: ${summaryKey}`);
    } else if (!dryRun) {
      console.log(
        `[Resumo WhatsApp] Não marcou ${summaryKey}: enviados=${result.counts.sent}, falhas=${result.counts.failed}, sem_grupo=${blockingSkips.length}.`
      );
    }

    return result;
  } catch (error) {
    result.reason = 'general_error';
    result.error = describeError(error);

    console.error(
      'Erro geral no resumo WhatsApp:',
      result.error
    );
    await notifyAttention(
      `client_summary_general_error:${targetDate || 'unknown'}`,
      'Erro geral no resumo WhatsApp',
      { targetDate, error: result.error }
    );

    return result;
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
    whatsappConnected: waConnected,
    whatsapp: getWhatsAppRuntimeStatus(),
    redisConnected: !!redis,
    pollingEnabled: POLLING_ENABLED,
    notifyStatuses: NOTIFY_STATUSES,
    meetStatusName: MEET_STATUS_NAME,
    clientSummaryEnabled: CLIENT_SUMMARY_ENABLED,
    clientSummaryTime: CLIENT_SUMMARY_TIME,
    whatsappDebugLogs: WHATSAPP_DEBUG_LOGS,
    errorNotificationEnabled: ERROR_NOTIFICATION_ENABLED,
    errorNotificationWebhookConfigured: Boolean(ERROR_NOTIFICATION_WEBHOOK_URL),
    errorNotificationWhatsappConfigured: Boolean(ERROR_NOTIFICATION_WHATSAPP_GROUP_ID)
  });
});

app.get('/debug-whatsapp', (req, res) => {
  res.status(200).json({
    whatsapp: getWhatsAppRuntimeStatus()
  });
});

app.get('/debug-whatsapp-summary', async (req, res) => {
  const send = req.query.send === 'true';
  const force = send || req.query.force !== 'false';
  const resetNotified = req.query.reset === 'true';

  const result = await processClientMorningSummary({
    force,
    dryRun: !send,
    resetNotified,
    source: 'debug-endpoint'
  });

  res.status(200).json(result);
});

app.get('/debug-alerts/:id', async (req, res) => {
  try {
    const issue = await fetchIssueDetails(req.params.id);
    const preferredDate = req.query.date || getAppointmentDate(issue);
    const appointment = parseAppointmentDateTime(issue, preferredDate);
    const waGroupId = await getWhatsAppGroupId(issue);
    const dataAgendamento = appointment
      ? dayjs(appointment.dateTime).tz(TZ)
      : null;
    const diffSeconds = dataAgendamento
      ? dataAgendamento.diff(dayjs().tz(TZ), 'second')
      : null;
    const response = {
      issue: issue.id,
      status: issue.status?.name,
      isMeetStatus: isStrictMeetStatus(issue),
      startDate: issue.start_date || null,
      dueDate: issue.due_date || null,
      selectedDate: appointment?.date || preferredDate || null,
      horarioCampo: getCustomFieldValue(issue, ALERT_FIELD_NAME),
      horario: appointment?.timeLabel || null,
      dataCompleta: appointment?.dateTime || null,
      diffSeconds,
      grupoWhatsapp: waGroupId,
      grupoWhatsappJid: normalizeWhatsAppGroupJid(waGroupId),
      googleMeet: getCustomFieldValue(issue, 'Google Meet'),
      whatsapp: getWhatsAppRuntimeStatus(),
      alertConfig: {
        mattermostMinutesBefore: Number(ALERT_MINUTES_BEFORE || 10),
        mattermostExtraMinutesBefore: Number(ALERT_EXTRA_MINUTES_BEFORE || 2),
        whatsappMinutesBefore: Number(WHATSAPP_ALERT_MINUTES_BEFORE || 5),
        windowSeconds: Number(ALERT_WINDOW_SECONDS || 180)
      }
    };

    if (req.query.sendWhatsApp === 'true') {
      if (!appointment || !waGroupId) {
        response.manualSend = {
          sent: false,
          reason: !appointment ? 'invalid_appointment' : 'missing_group'
        };
      } else {
        response.manualSend = await sendWhatsAppText(
          waGroupId,
          buildWhatsAppMessage(
            issue,
            Number(WHATSAPP_ALERT_MINUTES_BEFORE || 5),
            appointment.timeLabel
          ),
          `debug-alerts #${issue.id}`
        );
      }
    }

    res.json(response);
  } catch (err) {
    res.status(500).json({
      erro: describeError(err)
    });
  }
});

app.get('/debug-meet/:id', async (req, res) => {
  try {
    const issue = await fetchIssueDetails(req.params.id);

    const issueWithUrl = {
      ...issue,
      url: `${REDMINE_URL}/issues/${issue.id}`
    };

    await processGoogleMeet(issueWithUrl);

    res.json({
      success: true,
      issue: issue.id,
      status: issue.status?.name,
      startDate: issue.start_date,
      dueDate: issue.due_date,
      horario: getCustomFieldValue(issue, ALERT_FIELD_NAME),
      estimatedHours: issue.estimated_hours,
      googleMeet: getCustomFieldValue(issue, 'Google Meet')
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.response?.data || err.message
    });
  }
});

app.get('/debug-google', async (req, res) => {
  try {
    const calendar = getGoogleCalendarClient();
    const result = await calendar.calendarList.list();

    res.json({
      success: true,
      calendarId: GOOGLE_CALENDAR_ID,
      calendars: result.data.items.map(c => ({
        id: c.id,
        summary: c.summary
      }))
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.response?.data || err.message
    });
  }
});

app.get('/debug-send-mattermost/:id', async (req, res) => {
  try {
    const issue = await fetchIssueDetails(req.params.id);
    const targets = await getResponsibleTargets(issue);

    await notifyTargets(
      targets,
      buildNotificationMessage(issue, 'Teste manual', 'Debug')
    );

    res.json({
      success: true,
      issue: issue.id,
      status: issue.status?.name,
      assignedTo: issue.assigned_to || issue.assignee || null,
      targets
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.response?.data || err.message
    });
  }
});

app.get('/debug-notify/:id', async (req, res) => {
  try {
    const issue = await fetchIssueDetails(req.params.id);

    const lastJournal = getLastJournal(issue);

    const eventKey = getEventKey(
      issue,
      'Polling',
      lastJournal
    );

    res.json({
      issue: issue.id,
      status: issue.status?.name,
      shouldNotify: shouldNotifyStandardStatus(issue),
      isMeetStatus: isStrictMeetStatus(issue),
      eventKey,
      alreadyNotified: await wasAlreadyNotified(eventKey),
      lastJournalId: lastJournal?.id || null
    });

  } catch (err) {
    res.status(500).json({
      error: err.response?.data || err.message
    });
  }
});

app.get('/debug-polling-now', async (req, res) => {
  try {
    await pollingRedmineIssues();

    res.json({
      success: true,
      message: 'Polling executado manualmente. Veja os logs do Render.'
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.response?.data || err.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor rodando com sucesso na porta ${PORT}`);

  console.log('Configuração carregada:', {
    pollingEnabled: POLLING_ENABLED,
    pollingIntervalSeconds: Number(POLLING_INTERVAL_SECONDS),
    pollingLimit: Number(POLLING_LIMIT),
    notifyStatuses: NOTIFY_STATUSES,
    meetStatusName: MEET_STATUS_NAME
  });

  if (POLLING_ENABLED !== 'true') {
    console.log('[POLLING] Não iniciado: POLLING_ENABLED diferente de true.');
    return;
  }

  console.log('[POLLING] Intervalo registrado.');

  setInterval(() => {
    pollingRedmineIssues().catch(err => {
      console.error('[POLLING] Erro no intervalo:', err.response?.data || err.message);
    });
  }, Number(POLLING_INTERVAL_SECONDS) * 1000);

  setInterval(() => {
    pollingAppointmentAlerts().catch(err => {
      console.error('[ALERTAS] Erro no intervalo:', err.response?.data || err.message);
    });
  }, Number(ALERT_POLLING_INTERVAL_SECONDS) * 1000);

  setInterval(() => {
    processDailySummary().catch(err => {
      console.error('[SUMMARY] Erro:', err.response?.data || err.message);
    });
  }, 60 * 1000);

  setInterval(() => {
    processClientMorningSummary().catch(err => {
      console.error('[WHATSAPP SUMMARY] Erro:', err.response?.data || err.message);
    });
  }, 60 * 1000);

  setInterval(() => {
    processMeetRecordings().catch(err => {
      console.error('[DRIVE] Erro:', err.response?.data || err.message);
    });
  }, 5 * 60 * 1000);

  setTimeout(() => {
    pollingRedmineIssues().catch(err => {
      console.error('[POLLING] Erro primeira execução:', err.response?.data || err.message);
    });
  }, 10000);
});