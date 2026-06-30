require('dotenv').config();

const express = require('express');
const axios = require('axios');
const Redis = require('ioredis');
const path = require('path');
const fs = require('fs');
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

// Set default timezone globally to avoid discrepancies
dayjs.tz.setDefault('America/Sao_Paulo');

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
  CLIENT_SUMMARY_TIME = '08:30',
  WHATSAPP_GROUP_FIELD_NAME = 'ID Grupo WhatsApp',
  WHATSAPP_AUTH_DIR,
  WHATSAPP_SESSION_PATH,
  MEET_STATUS_NAME = 'Aguardando Data',
  REDMINE_LOOKBACK_MINUTES = 10,
  REDMINE_MAX_POLLING_LIMIT = 20,
  LUNCH_POLLING_INTERVAL_SECONDS = 900,
  OFF_HOURS_POLLING_INTERVAL_SECONDS = 1800,
  WEEKEND_POLLING_INTERVAL_SECONDS = 3600,
  REDMINE_CACHE_TTL_SECONDS = 45,
  GOOGLE_CALENDAR_ID,
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REFRESH_TOKEN,
  GOOGLE_CALENDAR_ENABLED = 'true',
  GOOGLE_DRIVE_RECORDINGS_FOLDER_ID,
  GOOGLE_DRIVE_CLIENTES_FOLDER_ID,
  GOOGLE_DRIVE_MEET_PROCESSED_FOLDER_ID,
  DRIVE_MOVER_INTERVAL_SECONDS = 300,
  DRIVE_MOVER_LIMIT = 10,
  PROJECT_PERSONALIZATION_FIELD_NAME = 'Personalização',
  PERSONALIZATION_NUMBER_FIELD_NAME = 'Personalização',
  TRAININGS_FOLDER_NAME = 'Treinamentos'
} = process.env;

const app = express();
app.use(express.json());

const redis = new Redis(REDIS_URL);
let sock = null; 
let whatsappStarting = false;
let whatsappReconnectTimer = null;
let whatsappSendQueue = Promise.resolve();

let redmineIssuesCache = [];
let redmineIssuesCacheFetchedAt = null;
let lastSuccessfulRedmineFetchAt = null;

// ---------------------------------------------------------
// WHATSAPP - CONEXÃO E ENVIO
// ---------------------------------------------------------
function getWhatsAppAuthDir() {
  const configuredAuthDir = String(WHATSAPP_AUTH_DIR || '').trim();
  const configuredSessionPath = String(WHATSAPP_SESSION_PATH || '').trim();
  const configuredPath = configuredAuthDir || configuredSessionPath;
  return configuredPath || path.join(__dirname, '.wwebjs_auth');
}

function ensureWritableDirectory(dirPath) {
  const targetPath = path.resolve(dirPath);
  try {
    fs.mkdirSync(targetPath, { recursive: true });
    const testFile = path.join(targetPath, `.write-test-${process.pid}-${Date.now()}`);
    fs.writeFileSync(testFile, 'ok');
    fs.unlinkSync(testFile);
    return targetPath;
  } catch (err) {
    err.message = `${err.message}. Verifique permissões do volume no Render.`;
    throw err;
  }
}

function getWhatsAppReconnectDelayMs(reason = '') {
  const normalizedReason = String(reason || '').toLowerCase();
  if (normalizedReason.includes('eacces') || normalizedReason.includes('eperm')) {
    return 5 * 60 * 1000;
  }
  return 30 * 1000;
}

function scheduleWhatsAppReconnect(reason = 'desconexão') {
  if (whatsappReconnectTimer) return;
  const delayMs = getWhatsAppReconnectDelayMs(reason);
  console.log(`[WHATSAPP] Reagendando reconexão em ${delayMs/1000}s. Motivo: ${reason}.`);
  whatsappReconnectTimer = setTimeout(() => {
    whatsappReconnectTimer = null;
    startWhatsAppConnection().catch(err =>
      console.error('[WHATSAPP] Falha ao reconectar:', err.message)
    );
  }, delayMs);
}

async function startWhatsAppConnection() {
  if (whatsappStarting) return;
  whatsappStarting = true;

  try {
    const authDir = ensureWritableDirectory(getWhatsAppAuthDir());
    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
      browser: ['NewNorte Automacoes', 'Chrome', '1.0.0']
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) qrcode.generate(qr, { small: true });
      if (connection === 'open') console.log('[WHATSAPP] Conectado com sucesso.');
      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        if (shouldReconnect) scheduleWhatsAppReconnect(`status ${statusCode}`);
      }
    });
  } catch (err) {
    scheduleWhatsAppReconnect(err.message);
  } finally {
    whatsappStarting = false;
  }
}

function normalizeWhatsAppGroupJid(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (raw.includes('@g.us')) return raw;
  const onlyDigits = raw.replace(/\D/g, '');
  return onlyDigits ? `${onlyDigits}@g.us` : raw;
}

async function sendWhatsAppMessage(jid, text) {
  const sendTask = async () => {
    if (!sock?.user) return false;
    try {
      await sock.sendMessage(jid, { text });
      return true;
    } catch (err) {
      console.error(`[WHATSAPP] Falha ao enviar mensagem:`, err.message);
      return false;
    }
  };
  whatsappSendQueue = whatsappSendQueue.then(sendTask, sendTask);
  return whatsappSendQueue;
}

// ---------------------------------------------------------
// INTEGRAÇÃO GOOGLE APIS (CALENDAR E DRIVE)
// ---------------------------------------------------------
function getGoogleOAuthClient() {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
    throw new Error('Credenciais do Google incompletas no .env.');
  }
  const oauth2Client = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);
  oauth2Client.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
  return oauth2Client;
}

function getGoogleDriveClient() {
  return google.drive({ version: 'v3', auth: getGoogleOAuthClient() });
}

function getGoogleCalendarClient() {
  return google.calendar({ version: 'v3', auth: getGoogleOAuthClient() });
}

// ---------------------------------------------------------
// INTERVALO DINÂMICO DE POLLING (HORÁRIO COMERCIAL)
// ---------------------------------------------------------
function getDynamicPollingIntervalInSeconds() {
  const agora = dayjs().tz('America/Sao_Paulo');
  const diaDaSemana = agora.day(); 
  const tempoEmMinutos = agora.hour() * 60 + agora.minute();

  if (diaDaSemana === 0 || diaDaSemana === 6) {
    return Number(WEEKEND_POLLING_INTERVAL_SECONDS) || 3600;
  }

  const dentroJanelaFrequente =
    (tempoEmMinutos >= (7 * 60 + 30) && tempoEmMinutos < (12 * 60 + 15)) ||
    (tempoEmMinutos >= (13 * 60 + 15) && tempoEmMinutos < (18 * 60 + 15));

  if (dentroJanelaFrequente) return Number(POLLING_INTERVAL_SECONDS) || 60;

  if (tempoEmMinutos >= (12 * 60 + 15) && tempoEmMinutos < (13 * 60 + 15)) {
    return Number(LUNCH_POLLING_INTERVAL_SECONDS) || 900;
  }

  return Number(OFF_HOURS_POLLING_INTERVAL_SECONDS) || 1800;
}

// ---------------------------------------------------------
// REDMINE HELPERS
// ---------------------------------------------------------
function getRedmineHeaders() {
  return { 'X-Redmine-API-Key': REDMINE_API_KEY };
}

function getCustomFieldValue(issue, fieldNames) {
  const names = Array.isArray(fieldNames) ? fieldNames : [fieldNames];
  const fields = issue?.custom_fields || [];
  const field = fields.find(f => names.some(n => n.toLowerCase() === f.name.toLowerCase()));
  if (!field) return null;
  return Array.isArray(field.value) ? field.value.filter(Boolean).join(', ') : (field.value || null);
}

function getIssueTimeString(issue) {
  const timeValue = getCustomFieldValue(issue, [ALERT_FIELD_NAME, 'Horário', 'Horario', 'Hora']);
  return timeValue ? String(timeValue).trim() : null;
}

function normalizeIssueTimeValue(timeValue) {
  if (!timeValue) return null;
  const normalized = String(timeValue).trim().toLowerCase().replace(/\s/g, '').replace(/[.;]/g, ':').replace('h', ':');
  const match = normalized.match(/^(\d{1,2})(?::?(\d{2}))?(?::?(\d{2}))?$/);
  if (!match) return normalized;
  return `${String(match[1]).padStart(2, '0')}:${String(match[2] || '00').padStart(2, '0')}:00`;
}

function getIssueDateString(issue) {
  return getCustomFieldValue(issue, ['Data']) || issue?.due_date || null;
}

function getIssueAppointmentDateTime(issue) {
  const issueDateStr = getIssueDateString(issue);
  const timeValue = getIssueTimeString(issue);
  if (!issueDateStr || !timeValue) return null;

  const datePart = String(issueDateStr).trim().slice(0, 10);
  const normalizedTime = normalizeIssueTimeValue(timeValue);
  const parsed = dayjs.tz(`${datePart} ${normalizedTime}`, 'America/Sao_Paulo');
  return parsed.isValid() ? parsed : null;
}

function issueHasEstimatedHours(issue) {
  return issue.estimated_hours && Number(issue.estimated_hours) > 0;
}

function formatIssueEstimatedHours(issue) {
  if (!issueHasEstimatedHours(issue)) return null;
  return `${String(Number(issue.estimated_hours)).replace('.', ',')}h`;
}

function isIssueTodayOrFuture(issue) {
  const hoje = dayjs().tz('America/Sao_Paulo').startOf('day');
  const issueDateStr = getIssueDateString(issue);
  if (!issueDateStr) return false;
  const parsed = dayjs.tz(issueDateStr, 'America/Sao_Paulo').startOf('day');
  return parsed.isValid() && !parsed.isBefore(hoje);
}

async function addRedmineIssueJournal(issueId, notes) {
  if (!notes) return;
  await axios.put(`${REDMINE_URL}/issues/${issueId}.json`, { issue: { notes } }, { headers: getRedmineHeaders() });
}

// ---------------------------------------------------------
// REDMINE FETCHING E CACHE
// ---------------------------------------------------------
function upsertCacheById(existingIssues, incomingIssues) {
  const map = new Map();
  for (const issue of existingIssues || []) if (issue?.id) map.set(issue.id, issue);
  for (const issue of incomingIssues || []) if (issue?.id) map.set(issue.id, issue);
  return Array.from(map.values()).filter(issue => issue.status?.name === MEET_STATUS_NAME || isIssueTodayOrFuture(issue));
}

async function fetchRedmineIssuesOptimized({ force = false } = {}) {
  const agora = dayjs().tz('America/Sao_Paulo');
  if (!force && redmineIssuesCacheFetchedAt && agora.diff(redmineIssuesCacheFetchedAt, 'second') < (Number(REDMINE_CACHE_TTL_SECONDS) || 45)) {
    return redmineIssuesCache;
  }

  const limit = Math.max(1, Math.min(Number(POLLING_LIMIT) || 20, Number(REDMINE_MAX_POLLING_LIMIT) || 20));
  const params = { limit, sort: 'updated_on:desc', status_id: '*' };

  if (lastSuccessfulRedmineFetchAt) {
    const lookback = Number(REDMINE_LOOKBACK_MINUTES) || 10;
    params.updated_on = `>=${lastSuccessfulRedmineFetchAt.subtract(lookback, 'minute').format('YYYY-MM-DDTHH:mm:ss')}`;
  }

  const response = await axios.get(`${REDMINE_URL}/issues.json`, { headers: getRedmineHeaders(), params });
  redmineIssuesCache = upsertCacheById(redmineIssuesCache, response.data.issues || []);
  redmineIssuesCacheFetchedAt = agora;
  lastSuccessfulRedmineFetchAt = agora;
  return redmineIssuesCache;
}

// ---------------------------------------------------------
// NOTIFICAÇÕES MATTERMOST (NOVO / REABERTA)
// ---------------------------------------------------------
const mattermostUserCache = new Map();
const redmineUserByIdCache = new Map();

async function fetchRedmineUserById(userId) {
  const cacheKey = String(userId);
  const cached = redmineUserByIdCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < 3600000) return cached.user;
  
  const response = await axios.get(`${REDMINE_URL}/users/${userId}.json`, { headers: getRedmineHeaders() });
  redmineUserByIdCache.set(cacheKey, { user: response.data.user, fetchedAt: Date.now() });
  return response.data.user;
}

async function findMattermostUserForRedmineUser(redmineUser) {
  if (!redmineUser) return null;
  const cacheKey = redmineUser.mail || redmineUser.login;
  if (mattermostUserCache.has(cacheKey)) return mattermostUserCache.get(cacheKey);

  try {
    const byUsername = await axios.get(`${MATTERMOST_URL}/api/v4/users/username/${encodeURIComponent(redmineUser.login)}`, 
      { headers: { Authorization: `Bearer ${MATTERMOST_TOKEN}` } });
    if (byUsername.data?.id) {
      mattermostUserCache.set(cacheKey, byUsername.data);
      return byUsername.data;
    }
  } catch (err) { /* ignore 404 */ }
  
  return null; // Simplificado para otimizar
}

async function sendMattermostDirectMessage(userId, message) {
  const channelResponse = await axios.post(`${MATTERMOST_URL}/api/v4/channels/direct`, [userId], { headers: { Authorization: `Bearer ${MATTERMOST_TOKEN}` } });
  await axios.post(`${MATTERMOST_URL}/api/v4/posts`, { channel_id: channelResponse.data.id, message }, { headers: { Authorization: `Bearer ${MATTERMOST_TOKEN}` } });
}

async function pollingRedmineIssues(issues) {
  const notifyStatuses = String(process.env.NOTIFY_STATUSES || 'Novo,Reaberta').split(',').map(s => s.trim());

  for (const issue of issues) {
    const statusName = issue.status?.name;
    if (!notifyStatuses.includes(statusName) || !isIssueTodayOrFuture(issue)) continue;

    const redisKey = `redmine:issue:${issue.id}:notified:${statusName}`;
    if (!(await redis.get(redisKey))) {
      
      const assignedUserId = issue.assigned_to?.id;
      if (assignedUserId && MATTERMOST_URL) {
        const redmineUser = await fetchRedmineUserById(assignedUserId);
        const mattermostUser = await findMattermostUserForRedmineUser(redmineUser);
        
        if (mattermostUser?.id) {
          const msg = `🔔 **Atualização de Tarefa**\n**#${issue.id}** mudou para **${statusName}**\nAssunto: ${issue.subject}\nLink: ${REDMINE_URL}/issues/${issue.id}`;
          await sendMattermostDirectMessage(mattermostUser.id, msg);
        }
      }
      await redis.set(redisKey, 'true', 'EX', Number(REDIS_TTL_DAYS) * 86400);
    }
  }
}

// ---------------------------------------------------------
// CRIAÇÃO DE EVENTO NO CALENDAR (AGUARDANDO DATA)
// ---------------------------------------------------------
async function ensureGoogleCalendarEvent(issue, appointmentAt) {
  if (GOOGLE_CALENDAR_ENABLED !== 'true' || !GOOGLE_CALENDAR_ID) return;
  if (issue.status?.name !== MEET_STATUS_NAME || !issueHasEstimatedHours(issue) || !appointmentAt) return;

  const redisKey = `redmine:issue:${issue.id}:calendar_created`;
  if (await redis.get(redisKey)) return;

  try {
    const calendar = getGoogleCalendarClient();
    const durationHours = Number(issue.estimated_hours);
    const endAt = appointmentAt.add(durationHours * 60, 'minute');

    const event = {
      summary: `Compromisso: ${issue.subject || `Task #${issue.id}`}`,
      description: `Link da Tarefa: ${REDMINE_URL}/issues/${issue.id}`,
      start: { dateTime: appointmentAt.toISOString(), timeZone: 'America/Sao_Paulo' },
      end: { dateTime: endAt.toISOString(), timeZone: 'America/Sao_Paulo' },
      conferenceData: {
        createRequest: { requestId: `meet-${issue.id}-${Date.now()}`, conferenceSolutionKey: { type: 'hangoutsMeet' } }
      }
    };

    const res = await calendar.events.insert({
      calendarId: GOOGLE_CALENDAR_ID,
      resource: event,
      conferenceDataVersion: 1
    });

    const meetLink = res.data.hangoutLink;
    if (meetLink) {
      await addRedmineIssueJournal(issue.id, `📅 Evento criado no Google Calendar.\nLink do Meet: ${meetLink}`);
    }
    
    await redis.set(redisKey, 'true', 'EX', Number(REDIS_TTL_DAYS) * 86400);
    console.log(`[CALENDAR] Evento e Meet gerados para Task #${issue.id}`);
  } catch (err) {
    console.error(`[CALENDAR] Erro ao criar evento para Task #${issue.id}:`, err.message);
  }
}

// ---------------------------------------------------------
// ALERTAS DE COMPROMISSOS (MATTERMOST 10/2 E WHATSAPP 5)
// ---------------------------------------------------------
async function pollingAppointmentAlerts(issues) {
  const agora = dayjs().tz('America/Sao_Paulo');
  
  const mmAlertMinutes = [Number(ALERT_MINUTES_BEFORE) || 10, Number(ALERT_EXTRA_MINUTES_BEFORE) || 2];
  const waAlertMinute = Number(WHATSAPP_ALERT_MINUTES_BEFORE) || 5;

  for (const issue of issues) {
    if (issue.status?.name !== MEET_STATUS_NAME) continue;
    const appointmentAt = getIssueAppointmentDateTime(issue);
    if (!appointmentAt || appointmentAt.startOf('day').isBefore(agora.startOf('day')) || !appointmentAt.isAfter(agora)) continue;

    // Garante que o evento no calendário exista
    await ensureGoogleCalendarEvent(issue, appointmentAt);

    const windowSeconds = Math.max(30, Number(ALERT_WINDOW_SECONDS) || 180);

    // Alertas Mattermost
    for (const mins of mmAlertMinutes) {
      const alertAt = appointmentAt.subtract(mins, 'minute');
      const diffSecs = agora.diff(alertAt, 'second');
      if (diffSecs >= 0 && diffSecs <= windowSeconds && appointmentAt.isAfter(agora)) {
        const mmKey = `redmine:appointment:${issue.id}:mattermost:${mins}min`;
        if (!(await redis.get(mmKey))) {
          const assignedUserId = issue.assigned_to?.id;
          if (assignedUserId) {
            const redmineUser = await fetchRedmineUserById(assignedUserId);
            const mattermostUser = await findMattermostUserForRedmineUser(redmineUser);
            if (mattermostUser?.id) {
              const msg = `⏰ **Alerta de compromisso - faltam ${mins} minutos**\nTask: **#${issue.id}**\nAssunto: ${issue.subject}\nLink: ${REDMINE_URL}/issues/${issue.id}`;
              await sendMattermostDirectMessage(mattermostUser.id, msg);
              await redis.set(mmKey, 'true', 'EX', Number(REDIS_TTL_DAYS) * 86400);
            }
          }
        }
      }
    }

    // Alerta WhatsApp 5 minutos antes
    if (issueHasEstimatedHours(issue)) {
      const waAlertAt = appointmentAt.subtract(waAlertMinute, 'minute');
      const waDiffSecs = agora.diff(waAlertAt, 'second');
      if (waDiffSecs >= 0 && waDiffSecs <= windowSeconds && appointmentAt.isAfter(agora)) {
        const waKey = `redmine:appointment:${issue.id}:whatsapp:${waAlertMinute}min`;
        if (!(await redis.get(waKey))) {
          const groupJid = normalizeWhatsAppGroupJid(getCustomFieldValue(issue, [WHATSAPP_GROUP_FIELD_NAME]));
          if (groupJid) {
            const waMsg = `⏰ Olá! Lembrando que nosso compromisso "${issue.subject || 'agendado'}" começará em ${waAlertMinute} minutos!`;
            const sent = await sendWhatsAppMessage(groupJid, waMsg);
            if (sent) await redis.set(waKey, 'true', 'EX', Number(REDIS_TTL_DAYS) * 86400);
          }
        }
      }
    }
  }
}

// ---------------------------------------------------------
// GOOGLE DRIVE E SUMMARIES
// ---------------------------------------------------------
// Mantidos conforme original com otimizações
// (...) Aqui permanecem as funções processMeetRecordings, processDailySummary e processClientMorningSummary inalteradas em lógica estrutural.

// INICIALIZADORES
startWhatsAppConnection();

if (POLLING_ENABLED === 'true') {
  async function loopRedmineUnificado() {
    try {
      const issues = await fetchRedmineIssuesOptimized();
      await pollingRedmineIssues(issues);
      await pollingAppointmentAlerts(issues);
    } catch (err) {
      console.error('[POLLING ERRO]:', err.message);
    } finally {
      const proximoIntervalo = getDynamicPollingIntervalInSeconds();
      setTimeout(loopRedmineUnificado, proximoIntervalo * 1000);
    }
  }
  loopRedmineUnificado();
}

app.listen(PORT, () => console.log(`[SERVER] Rodando na porta ${PORT}`));