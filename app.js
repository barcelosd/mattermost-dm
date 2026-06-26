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
dayjs.tz.setDefault('America/Sao_Paulo');

const TZ = 'America/Sao_Paulo';

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

  NOTIFY_STATUSES = 'Novo,Reaberta',
  IGNORE_STATUSES = '',

  MEET_STATUS_NAME = 'Aguardando Data',
  ALERT_FIELD_NAME = 'Horário',
  ALERT_MINUTES_BEFORE = 10,
  ALERT_EXTRA_MINUTES_BEFORE = 2,
  WHATSAPP_ALERT_MINUTES_BEFORE = 5,
  ALERT_WINDOW_SECONDS = 180,

  DAILY_SUMMARY_ENABLED = 'true',
  DAILY_SUMMARY_HOUR = 17,
  DAILY_SUMMARY_MINUTE = 45,
  CLIENT_SUMMARY_TIME = '08:30',

  GOOGLE_CALENDAR_ID,
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REFRESH_TOKEN,
  GOOGLE_MEET_PROJECT_FIELD_NAME = 'Nome Fantasia',

  WHATSAPP_GROUP_FIELD_NAME = 'ID Grupo WhatsApp',
  WHATSAPP_ENABLED = 'true',
  GOOGLE_CALENDAR_ENABLED = 'true',
  LOG_SKIPPED_EVENTS = 'false'
} = process.env;

const app = express();
app.use(express.json());

const redis = REDIS_URL ? new Redis(REDIS_URL) : null;
let sock = null;

const ttlSeconds = Number(REDIS_TTL_DAYS) * 24 * 60 * 60;
const notifyStatuses = csv(NOTIFY_STATUSES);
const ignoreStatuses = csv(IGNORE_STATUSES);

const mattermost = axios.create({
  baseURL: MATTERMOST_URL ? `${MATTERMOST_URL.replace(/\/$/, '')}/api/v4` : '',
  headers: MATTERMOST_TOKEN ? { Authorization: `Bearer ${MATTERMOST_TOKEN}` } : {}
});

const redmine = axios.create({
  baseURL: REDMINE_URL ? REDMINE_URL.replace(/\/$/, '') : '',
  headers: REDMINE_API_KEY ? { 'X-Redmine-API-Key': REDMINE_API_KEY } : {}
});

function csv(value) {
  return String(value || '')
    .split(',')
    .map(s => s.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
}

function logSkip(...args) {
  if (String(LOG_SKIPPED_EVENTS).toLowerCase() === 'true') console.log('[SKIP]', ...args);
}

function normalize(value) {
  return String(value || '').trim().toLowerCase();
}

function isSameStatus(a, b) {
  return normalize(a) === normalize(b);
}

function getCustomField(issue, name) {
  return (issue.custom_fields || []).find(f => isSameStatus(f.name, name));
}

function getCustomValue(issue, name) {
  const field = getCustomField(issue, name);
  if (!field) return '';
  if (Array.isArray(field.value)) return field.value.filter(Boolean).join(', ');
  return String(field.value || '').trim();
}

function getIssueDateStr(issue) {
  return getCustomValue(issue, 'Data') || issue.due_date || '';
}

function getIssueTimeStr(issue) {
  return getCustomValue(issue, ALERT_FIELD_NAME);
}

function parseIssueDateTime(issue) {
  const dateStr = getIssueDateStr(issue);
  const timeStr = getIssueTimeStr(issue);

  if (!dateStr || !timeStr) return null;

  const cleanedTime = String(timeStr).trim().replace('h', ':');
  const candidates = [
    `${dateStr} ${cleanedTime}`,
    `${dateStr} ${cleanedTime}:00`
  ];

  for (const value of candidates) {
    const parsed = dayjs.tz(value, ['YYYY-MM-DD HH:mm', 'YYYY-MM-DD HH:mm:ss', 'DD/MM/YYYY HH:mm', 'DD/MM/YYYY HH:mm:ss'], TZ);
    if (parsed.isValid()) return parsed;
  }

  return null;
}

function isPastDay(dateStr) {
  if (!dateStr) return false;
  const date = dayjs.tz(dateStr, ['YYYY-MM-DD', 'DD/MM/YYYY'], TZ).startOf('day');
  return date.isValid() && date.isBefore(dayjs().tz(TZ).startOf('day'));
}

function isBusinessDay(d) {
  const day = d.day();
  return day >= 1 && day <= 5;
}

function nextBusinessDay(from = dayjs().tz(TZ)) {
  let d = from.add(1, 'day').startOf('day');
  while (!isBusinessDay(d)) d = d.add(1, 'day');
  return d;
}

function previousBusinessDay(from = dayjs().tz(TZ)) {
  let d = from.subtract(1, 'day').startOf('day');
  while (!isBusinessDay(d)) d = d.subtract(1, 'day');
  return d;
}

function isTodayMinute(hour, minute) {
  const now = dayjs().tz(TZ);
  return now.hour() === Number(hour) && now.minute() === Number(minute);
}

function shouldRunAtTime(key, hour, minute) {
  if (!isTodayMinute(hour, minute)) return false;
  return oncePerDay(key);
}

async function oncePerDay(key) {
  if (!redis) return true;
  const today = dayjs().tz(TZ).format('YYYY-MM-DD');
  const fullKey = `${key}:${today}`;
  const ok = await redis.set(fullKey, '1', 'EX', 36 * 60 * 60, 'NX');
  return ok === 'OK';
}

async function redisSetOnce(key, value = '1', ttl = ttlSeconds) {
  if (!redis) return true;
  const ok = await redis.set(key, value, 'EX', ttl, 'NX');
  return ok === 'OK';
}

function getDynamicPollingIntervalInSeconds() {
  const now = dayjs().tz(TZ);
  const day = now.day();
  const minutes = now.hour() * 60 + now.minute();

  if (day === 0 || day === 6) return 3600;

  const activeMorningStart = 7 * 60 + 30;
  const activeMorningEnd = 12 * 60 + 15;
  const activeAfternoonStart = 13 * 60 + 15;
  const activeAfternoonEnd = 18 * 60 + 15;

  const active =
    (minutes >= activeMorningStart && minutes <= activeMorningEnd) ||
    (minutes >= activeAfternoonStart && minutes <= activeAfternoonEnd);

  return active ? Number(POLLING_INTERVAL_SECONDS) || 60 : 900;
}

function redmineIssueUrl(issue) {
  return `${REDMINE_URL.replace(/\/$/, '')}/issues/${issue.id}`;
}

function formatIssueLine(issue) {
  const assigned = issue.assigned_to ? issue.assigned_to.name : 'sem responsável';
  return `#${issue.id} - ${issue.subject}\nStatus: ${issue.status?.name || '-'}\nResponsável: ${assigned}\nLink: ${redmineIssueUrl(issue)}`;
}

function redmineUserToMattermostUsername(issue) {
  const loginField = getCustomValue(issue, 'Mattermost') || getCustomValue(issue, 'Usuário Mattermost');
  if (loginField) return loginField.replace(/^@/, '');
  const name = issue.assigned_to?.name || '';
  return name
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '.')
    .replace(/^\.+|\.+$/g, '');
}

async function sendMattermostDM(username, message) {
  if (!MATTERMOST_URL || !MATTERMOST_TOKEN) {
    console.warn('[MATTERMOST] MATTERMOST_URL ou MATTERMOST_TOKEN ausente.');
    return false;
  }
  if (!username) {
    console.warn('[MATTERMOST] Usuário Mattermost não identificado.');
    return false;
  }

  try {
    const me = await mattermost.get('/users/me');
    const user = await mattermost.get(`/users/username/${encodeURIComponent(username)}`);
    const channel = await mattermost.post('/channels/direct', [me.data.id, user.data.id]);
    await mattermost.post('/posts', { channel_id: channel.data.id, message });
    console.log(`[MATTERMOST] DM enviada para @${username}`);
    return true;
  } catch (err) {
    console.error(`[MATTERMOST] Falha ao enviar DM para @${username}:`, err.response?.data || err.message);
    return false;
  }
}

async function sendIssueDM(issue, message) {
  return sendMattermostDM(redmineUserToMattermostUsername(issue), message);
}

async function startWhatsapp() {
  if (String(WHATSAPP_ENABLED).toLowerCase() !== 'true') return;
  try {
    const { state, saveCreds } = await useMultiFileAuthState('./baileys_auth');
    sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' })
    });

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
      if (qr) qrcode.generate(qr, { small: true });
      if (connection === 'open') console.log('[WHATSAPP] Conectado.');
      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        console.warn('[WHATSAPP] Desconectado.', code);
        if (code !== DisconnectReason.loggedOut) setTimeout(startWhatsapp, 5000);
      }
    });
  } catch (err) {
    console.error('[WHATSAPP] Falha ao inicializar:', err.message);
  }
}

async function sendWhatsappGroup(groupId, message) {
  if (!groupId) return false;
  if (!sock) {
    console.warn('[WHATSAPP] Socket ainda não conectado.');
    return false;
  }
  const jid = groupId.includes('@') ? groupId : `${groupId}@g.us`;
  try {
    await sock.sendMessage(jid, { text: message });
    console.log(`[WHATSAPP] Mensagem enviada ao grupo ${jid}`);
    return true;
  } catch (err) {
    console.error('[WHATSAPP] Falha ao enviar:', err.message);
    return false;
  }
}

function getGoogleCalendarClient() {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) return null;
  const oauth2 = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);
  oauth2.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
  return google.calendar({ version: 'v3', auth: oauth2 });
}

async function ensureCalendarEvent(issue) {
  if (String(GOOGLE_CALENDAR_ENABLED).toLowerCase() !== 'true') return;
  if (!GOOGLE_CALENDAR_ID) return;

  const start = parseIssueDateTime(issue);
  if (!start || !issue.estimated_hours) return;
  if (!isSameStatus(issue.status?.name, MEET_STATUS_NAME)) return;

  const key = `redmine:issue:${issue.id}:calendar-created`;
  const first = await redisSetOnce(key, '1');
  if (!first) return;

  const calendar = getGoogleCalendarClient();
  if (!calendar) {
    console.warn('[GOOGLE] Credenciais do Calendar ausentes.');
    return;
  }

  const end = start.add(Number(issue.estimated_hours) || 1, 'hour');
  const projectName = getCustomValue(issue, GOOGLE_MEET_PROJECT_FIELD_NAME);
  const summary = `${projectName ? projectName + ' - ' : ''}#${issue.id} ${issue.subject}`;

  try {
    await calendar.events.insert({
      calendarId: GOOGLE_CALENDAR_ID,
      conferenceDataVersion: 1,
      requestBody: {
        summary,
        description: `${formatIssueLine(issue)}`,
        start: { dateTime: start.toISOString(), timeZone: TZ },
        end: { dateTime: end.toISOString(), timeZone: TZ },
        conferenceData: {
          createRequest: {
            requestId: `redmine-${issue.id}-${Date.now()}`,
            conferenceSolutionKey: { type: 'hangoutsMeet' }
          }
        }
      }
    });
    console.log(`[GOOGLE] Evento criado para issue #${issue.id}`);
  } catch (err) {
    console.error('[GOOGLE] Falha ao criar evento:', err.response?.data || err.message);
    if (redis) await redis.del(key); // permite nova tentativa se houve falha real
  }
}

async function fetchRecentIssues(params = {}) {
  const response = await redmine.get('/issues.json', {
    params: {
      limit: Number(POLLING_LIMIT) || 20,
      sort: 'updated_on:desc',
      include: 'journals',
      ...params
    }
  });
  return response.data.issues || [];
}

async function pollingRedmineIssues() {
  console.log('[POLLING] Checando Redmine...');
  const issues = await fetchRecentIssues();

  for (const issue of issues) {
    const statusName = issue.status?.name || '';
    if (ignoreStatuses.some(s => isSameStatus(s, statusName))) {
      logSkip(`#${issue.id}`, `status ignorado: ${statusName}`);
      continue;
    }

    // Notificação de nova tarefa ou tarefa reaberta: não depende de data.
    if (notifyStatuses.some(s => isSameStatus(s, statusName))) {
      const key = `redmine:issue:${issue.id}:status:${normalize(statusName)}:assigned:${issue.assigned_to?.id || 'none'}`;
      const first = await redisSetOnce(key);
      if (first) {
        await sendIssueDM(issue, `🔔 Tarefa atribuída/atualizada no Redmine\n\n${formatIssueLine(issue)}`);
      }
    }

    // Quando a tarefa já nasce/pré-existe como Aguardando Data, com horário e tempo estimado, cria Calendar/Meet.
    await ensureCalendarEvent(issue);
  }
}

async function pollingAppointmentAlerts() {
  console.log('[ALERTAS] Verificando compromissos...');
  const issues = await fetchRecentIssues({ status_id: '*' });
  const now = dayjs().tz(TZ);
  const thresholds = [
    { name: `${ALERT_MINUTES_BEFORE}min`, minutes: Number(ALERT_MINUTES_BEFORE), channel: 'mattermost' },
    { name: `${ALERT_EXTRA_MINUTES_BEFORE}min`, minutes: Number(ALERT_EXTRA_MINUTES_BEFORE), channel: 'mattermost' },
    { name: `whatsapp-${WHATSAPP_ALERT_MINUTES_BEFORE}min`, minutes: Number(WHATSAPP_ALERT_MINUTES_BEFORE), channel: 'whatsapp' }
  ];

  for (const issue of issues) {
    const statusName = issue.status?.name || '';
    if (!isSameStatus(statusName, MEET_STATUS_NAME)) continue;

    const dateStr = getIssueDateStr(issue);
    if (!dateStr || isPastDay(dateStr)) continue;

    const appointmentAt = parseIssueDateTime(issue);
    if (!appointmentAt) continue;
    if (appointmentAt.isBefore(now)) continue;

    const diffSeconds = appointmentAt.diff(now, 'second');

    for (const threshold of thresholds) {
      const targetSeconds = threshold.minutes * 60;
      const delta = Math.abs(diffSeconds - targetSeconds);
      if (delta > Number(ALERT_WINDOW_SECONDS)) continue;

      const key = `redmine:appointment:${issue.id}:${appointmentAt.format('YYYYMMDDHHmm')}:${threshold.name}`;
      const first = await redisSetOnce(key, '1', 3 * 24 * 60 * 60);
      if (!first) continue;

      const msg = `⏰ Compromisso em ${threshold.minutes} minuto(s)\n\n${formatIssueLine(issue)}\nData/Hora: ${appointmentAt.format('DD/MM/YYYY HH:mm')}`;

      if (threshold.channel === 'whatsapp') {
        const groupId = getCustomValue(issue, WHATSAPP_GROUP_FIELD_NAME);
        await sendWhatsappGroup(groupId, msg);
      } else {
        await sendIssueDM(issue, msg);
      }
    }
  }
}

async function processDailySummary() {
  if (String(DAILY_SUMMARY_ENABLED).toLowerCase() !== 'true') return;
  const ok = await shouldRunAtTime('summary:daily', Number(DAILY_SUMMARY_HOUR), Number(DAILY_SUMMARY_MINUTE));
  if (!ok) return;

  const target = nextBusinessDay();
  await sendSummaryForDate(target, `📌 Resumo dos compromissos do próximo dia útil (${target.format('DD/MM/YYYY')})`);
}

async function processClientMorningSummary() {
  const [hour, minute] = String(CLIENT_SUMMARY_TIME).split(':').map(Number);
  const ok = await shouldRunAtTime('summary:client-morning', hour, minute);
  if (!ok) return;

  const today = dayjs().tz(TZ).startOf('day');
  await sendSummaryForDate(today, `📌 Compromissos de hoje (${today.format('DD/MM/YYYY')})`);
}

async function sendSummaryForDate(targetDay, title) {
  const issues = await fetchRecentIssues({ status_id: '*' });
  const grouped = new Map();

  for (const issue of issues) {
    if (!isSameStatus(issue.status?.name, MEET_STATUS_NAME)) continue;
    const at = parseIssueDateTime(issue);
    if (!at || !at.isSame(targetDay, 'day')) continue;

    const username = redmineUserToMattermostUsername(issue);
    if (!username) continue;
    if (!grouped.has(username)) grouped.set(username, []);
    grouped.get(username).push(`• ${at.format('HH:mm')} - #${issue.id} ${issue.subject}\n  ${redmineIssueUrl(issue)}`);
  }

  for (const [username, lines] of grouped.entries()) {
    await sendMattermostDM(username, `${title}\n\n${lines.join('\n')}`);
  }
}

async function processBusinessDayBeforeConfirmations() {
  const today = dayjs().tz(TZ).startOf('day');
  const tomorrowBusiness = nextBusinessDay(today);
  const issues = await fetchRecentIssues({ status_id: '*' });

  for (const issue of issues) {
    if (!isSameStatus(issue.status?.name, MEET_STATUS_NAME)) continue;
    if (!issue.estimated_hours) continue;

    const at = parseIssueDateTime(issue);
    if (!at || !at.isSame(tomorrowBusiness, 'day')) continue;

    const key = `redmine:issue:${issue.id}:confirm:${at.format('YYYYMMDD')}`;
    const first = await redisSetOnce(key, '1', 3 * 24 * 60 * 60);
    if (!first) continue;

    await sendIssueDM(issue, `✅ Confirme o compromisso do próximo dia útil\n\n${formatIssueLine(issue)}\nData/Hora: ${at.format('DD/MM/YYYY HH:mm')}\nTempo estimado: ${issue.estimated_hours}h`);
  }
}

async function processMeetRecordings() {
  // Implementação segura: mantém o loop vivo, mas não tenta mover arquivos sem IDs/credenciais.
  // Para mover gravações, é necessário mapear pasta de origem/destino e regra exata de nome do arquivo.
  return;
}

app.get('/health', (_, res) => {
  res.json({
    ok: true,
    time: dayjs().tz(TZ).format(),
    whatsapp: Boolean(sock),
    redis: Boolean(redis),
    pollingEnabled: POLLING_ENABLED === 'true'
  });
});

async function bootstrap() {
  if (!REDMINE_URL || !REDMINE_API_KEY) {
    console.warn('[CONFIG] REDMINE_URL ou REDMINE_API_KEY ausente.');
  }
  if (redis) {
    redis.on('error', err => console.error('[REDIS]', err.message));
  }

  await startWhatsapp();

  if (POLLING_ENABLED === 'true') {
    console.log('[POLLING] Inicializando loops.');

    function loopRedmine() {
      pollingRedmineIssues()
        .catch(err => console.error('[POLLING ERRO]:', err.response?.data || err.message))
        .finally(() => setTimeout(loopRedmine, getDynamicPollingIntervalInSeconds() * 1000));
    }

    function loopAlertas() {
      pollingAppointmentAlerts()
        .catch(err => console.error('[ALERTAS ERRO]:', err.response?.data || err.message))
        .finally(() => setTimeout(loopAlertas, getDynamicPollingIntervalInSeconds() * 1000));
    }

    loopRedmine();
    loopAlertas();
  }

  setInterval(() => {
    processDailySummary().catch(err => console.error('[SUMMARY ERR]:', err.response?.data || err.message));
    processClientMorningSummary().catch(err => console.error('[CLIENT SUMMARY ERR]:', err.response?.data || err.message));
    processBusinessDayBeforeConfirmations().catch(err => console.error('[CONFIRM ERR]:', err.response?.data || err.message));
    processMeetRecordings().catch(err => console.error('[DRIVE ERR]:', err.response?.data || err.message));
  }, 60 * 1000);

  app.listen(PORT, () => {
    console.log(`[SERVER] Aplicação rodando na porta ${PORT}`);
  });
}

bootstrap().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});
