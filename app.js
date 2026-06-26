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
const fs = require('fs');
const path = require('path');

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
  GOOGLE_MEET_FIELD_NAME = 'Google Meet',

  WHATSAPP_AUTH_DIR = './baileys_auth',
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
  // No Redmine, a tela mostra "Início", que na API vem como start_date.
  // Mantemos compatibilidade com campo personalizado "Data" e também due_date.
  return getCustomValue(issue, 'Data') || issue.start_date || issue.due_date || '';
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

function looksLikeEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

function normalizeMattermostUsername(value) {
  return String(value || '')
    .trim()
    .replace(/^@/, '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '.')
    .replace(/^\.+|\.+$/g, '');
}

async function getRedmineUserEmailById(userId) {
  if (!userId) return '';

  const cacheKey = `redmine:user:${userId}:email`;
  if (redis) {
    const cached = await redis.get(cacheKey);
    if (cached) return cached;
  }

  try {
    const res = await redmine.get(`/users/${userId}.json`);
    const email = String(res.data?.user?.mail || res.data?.user?.email || '').trim().toLowerCase();
    if (looksLikeEmail(email)) {
      if (redis) await redis.set(cacheKey, email, 'EX', 24 * 60 * 60);
      return email;
    }
  } catch (err) {
    console.warn(`[REDMINE] Não foi possível buscar e-mail do usuário ${userId}:`, err.response?.data || err.message);
  }

  return '';
}

async function getRedmineGroupMemberEmails(groupId) {
  if (!groupId) return [];

  const cacheKey = `redmine:group:${groupId}:member_emails`;
  if (redis) {
    const cached = await redis.get(cacheKey);
    if (cached) {
      try {
        const parsed = JSON.parse(cached);
        if (Array.isArray(parsed)) return parsed;
      } catch (_) {}
    }
  }

  const emails = new Set();

  // Preferencial: /users.json?group_id=ID costuma trazer o e-mail quando a API key tem permissão de admin.
  try {
    let offset = 0;
    const limit = 100;

    while (true) {
      const res = await redmine.get('/users.json', {
        params: { group_id: groupId, status: 1, limit, offset }
      });

      const users = res.data?.users || [];
      for (const user of users) {
        const email = String(user.mail || user.email || '').trim().toLowerCase();
        if (looksLikeEmail(email)) emails.add(email);
      }

      const total = Number(res.data?.total_count || users.length);
      offset += limit;
      if (!users.length || offset >= total) break;
    }
  } catch (err) {
    console.warn(`[REDMINE] Não foi possível listar usuários do grupo ${groupId} via /users.json?group_id:`, err.response?.data || err.message);
  }

  // Fallback: /groups/:id.json?include=users retorna membros, mas normalmente sem e-mail.
  // Por isso buscamos /users/:id.json para cada membro.
  if (!emails.size) {
    try {
      const res = await redmine.get(`/groups/${groupId}.json`, { params: { include: 'users' } });
      const users = res.data?.group?.users || [];

      for (const user of users) {
        const email = await getRedmineUserEmailById(user.id);
        if (looksLikeEmail(email)) emails.add(email);
      }
    } catch (err) {
      const status = err.response?.status;
      if (status !== 404) {
        console.warn(`[REDMINE] Não foi possível buscar membros do grupo ${groupId}:`, err.response?.data || err.message);
      }
    }
  }

  const result = Array.from(emails);
  if (redis && result.length) {
    await redis.set(cacheKey, JSON.stringify(result), 'EX', 15 * 60);
  }

  return result;
}

async function getRedmineAssignedUserEmail(issue) {
  const explicitEmail =
    getCustomValue(issue, 'E-mail') ||
    getCustomValue(issue, 'Email') ||
    getCustomValue(issue, 'Mattermost Email') ||
    getCustomValue(issue, 'E-mail Mattermost');

  if (looksLikeEmail(explicitEmail)) return explicitEmail.trim().toLowerCase();

  const assignedId = issue.assigned_to?.id;
  if (!assignedId) return '';

  const email = await getRedmineUserEmailById(assignedId);
  if (email) return email;

  const assignedName = String(issue.assigned_to?.name || '').trim();
  if (looksLikeEmail(assignedName)) return assignedName.toLowerCase();

  return '';
}

async function getRedmineAssigneeEmails(issue) {
  const assignedId = issue.assigned_to?.id;
  if (!assignedId) return [];

  // Primeiro tenta como grupo. Se não for grupo, a lista voltará vazia e cairemos no usuário individual.
  const groupEmails = await getRedmineGroupMemberEmails(assignedId);
  if (groupEmails.length) {
    console.log(`[REDMINE] Issue #${issue.id} atribuída ao grupo "${issue.assigned_to?.name}". ${groupEmails.length} membro(s) encontrado(s).`);
    return groupEmails;
  }

  const email = await getRedmineAssignedUserEmail(issue);
  return email ? [email] : [];
}

function redmineUserToMattermostUsername(issue) {
  const loginField = getCustomValue(issue, 'Mattermost') || getCustomValue(issue, 'Usuário Mattermost');
  if (loginField && !looksLikeEmail(loginField)) return normalizeMattermostUsername(loginField);
  return normalizeMattermostUsername(issue.assigned_to?.name || '');
}

async function getMattermostUserByEmail(email) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!looksLikeEmail(normalizedEmail)) return null;

  const cacheKey = `mattermost:user:email:${normalizedEmail}`;
  if (redis) {
    const cachedId = await redis.get(cacheKey);
    if (cachedId) return { id: cachedId, email: normalizedEmail };
  }

  const user = await mattermost.get(`/users/email/${encodeURIComponent(normalizedEmail)}`);
  if (redis && user.data?.id) await redis.set(cacheKey, user.data.id, 'EX', 24 * 60 * 60);
  return user.data;
}

async function getMattermostUserByUsername(username) {
  const normalizedUsername = normalizeMattermostUsername(username);
  if (!normalizedUsername) return null;

  const cacheKey = `mattermost:user:username:${normalizedUsername}`;
  if (redis) {
    const cachedId = await redis.get(cacheKey);
    if (cachedId) return { id: cachedId, username: normalizedUsername };
  }

  const user = await mattermost.get(`/users/username/${encodeURIComponent(normalizedUsername)}`);
  if (redis && user.data?.id) await redis.set(cacheKey, user.data.id, 'EX', 24 * 60 * 60);
  return user.data;
}

async function sendMattermostDMToUser(user, label, message) {
  const me = await mattermost.get('/users/me');
  const channel = await mattermost.post('/channels/direct', [me.data.id, user.id]);
  await mattermost.post('/posts', { channel_id: channel.data.id, message });
  console.log(`[MATTERMOST] DM enviada para ${label}`);
  return true;
}

async function sendMattermostDM(identifier, message) {
  if (!MATTERMOST_URL || !MATTERMOST_TOKEN) {
    console.warn('[MATTERMOST] MATTERMOST_URL ou MATTERMOST_TOKEN ausente.');
    return false;
  }

  const value = String(identifier || '').trim();
  if (!value) {
    console.warn('[MATTERMOST] Usuário/e-mail Mattermost não identificado.');
    return false;
  }

  try {
    if (looksLikeEmail(value)) {
      const user = await getMattermostUserByEmail(value);
      return sendMattermostDMToUser(user, value, message);
    }

    const user = await getMattermostUserByUsername(value);
    return sendMattermostDMToUser(user, `@${normalizeMattermostUsername(value)}`, message);
  } catch (err) {
    console.error(`[MATTERMOST] Falha ao enviar DM para ${value}:`, err.response?.data || err.message);
    return false;
  }
}

async function sendIssueDM(issue, message) {
  const emails = await getRedmineAssigneeEmails(issue);

  if (emails.length) {
    let sent = 0;

    for (const email of emails) {
      const ok = await sendMattermostDM(email, message);
      if (ok) sent += 1;
    }

    if (emails.length > 1) {
      console.log(`[MATTERMOST] Issue #${issue.id}: DM enviada para ${sent}/${emails.length} membro(s) do grupo "${issue.assigned_to?.name}".`);
    }

    return sent > 0;
  }

  const username = redmineUserToMattermostUsername(issue);
  console.warn(`[MATTERMOST] E-mail do responsável/grupo da issue #${issue.id} não encontrado. Tentando fallback por username: @${username}`);
  return sendMattermostDM(username, message);
}

async function startWhatsapp() {
  if (String(WHATSAPP_ENABLED).toLowerCase() !== 'true') return;
  try {
    const authDir = path.resolve(WHATSAPP_AUTH_DIR || './baileys_auth');
    fs.mkdirSync(authDir, { recursive: true });
    console.log(`[WHATSAPP] Usando pasta de autenticação: ${authDir}`);
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
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

async function updateIssueCustomField(issue, fieldName, value) {
  const field = getCustomField(issue, fieldName);
  if (!field?.id) return false;

  try {
    await redmine.put(`/issues/${issue.id}.json`, {
      issue: {
        custom_fields: [
          { id: field.id, value: value == null ? '' : String(value) }
        ]
      }
    });
    console.log(`[REDMINE] Campo "${fieldName}" atualizado na issue #${issue.id}`);
    return true;
  } catch (err) {
    console.error(`[REDMINE] Falha ao atualizar campo "${fieldName}" da issue #${issue.id}:`, err.response?.data || err.message);
    return false;
  }
}

function getMeetLinkFromCalendarEvent(event) {
  return event?.hangoutLink ||
    (event?.conferenceData?.entryPoints || []).find(p => p.entryPointType === 'video')?.uri ||
    '';
}


function getCalendarRedisKey(issueId) {
  return `redmine:issue:${issueId}:calendar-event-id`;
}

function getCalendarSignature(issue) {
  const status = issue.status?.name || '';
  const start = parseIssueDateTime(issue);
  const estimatedHours = Number(issue.estimated_hours);
  if (!isSameStatus(status, MEET_STATUS_NAME) || !start || !estimatedHours || estimatedHours <= 0) {
    return '';
  }
  return [
    normalize(status),
    start.format('YYYY-MM-DDTHH:mm'),
    Number(estimatedHours).toFixed(2),
    getIssueDateStr(issue),
    getIssueTimeStr(issue)
  ].join('|');
}

function shouldHaveCalendarEvent(issue) {
  return Boolean(getCalendarSignature(issue));
}

async function findCalendarEventForIssue(calendar, issue) {
  if (!calendar || !GOOGLE_CALENDAR_ID) return null;

  const cachedId = redis ? await redis.get(getCalendarRedisKey(issue.id)) : '';
  if (cachedId) {
    try {
      const event = await calendar.events.get({ calendarId: GOOGLE_CALENDAR_ID, eventId: cachedId });
      if (event?.data?.status !== 'cancelled') return event.data;
    } catch (err) {
      if (err.response?.status !== 404 && err.code !== 404) {
        console.warn(`[GOOGLE] Não consegui ler evento salvo da issue #${issue.id}:`, err.response?.data || err.message);
      }
    }
  }

  const privateProperty = `redmineIssueId=${issue.id}`;
  try {
    const res = await calendar.events.list({
      calendarId: GOOGLE_CALENDAR_ID,
      privateExtendedProperty: privateProperty,
      singleEvents: true,
      maxResults: 10,
      orderBy: 'updated'
    });
    const event = (res.data?.items || []).find(e => e.status !== 'cancelled');
    if (event?.id) {
      if (redis) await redis.set(getCalendarRedisKey(issue.id), event.id, 'EX', ttlSeconds);
      return event;
    }
  } catch (err) {
    console.warn(`[GOOGLE] Busca por extendedProperty falhou para issue #${issue.id}:`, err.response?.data || err.message);
  }

  // Compatibilidade com eventos criados antes dessa correção.
  try {
    const res = await calendar.events.list({
      calendarId: GOOGLE_CALENDAR_ID,
      q: `#${issue.id}`,
      singleEvents: true,
      maxResults: 10,
      orderBy: 'updated'
    });
    const event = (res.data?.items || []).find(e =>
      e.status !== 'cancelled' &&
      (String(e.summary || '').includes(`#${issue.id}`) || String(e.description || '').includes(`/issues/${issue.id}`))
    );
    if (event?.id) {
      if (redis) await redis.set(getCalendarRedisKey(issue.id), event.id, 'EX', ttlSeconds);
      return event;
    }
  } catch (err) {
    console.warn(`[GOOGLE] Busca textual falhou para issue #${issue.id}:`, err.response?.data || err.message);
  }

  return null;
}

async function clearCalendarEvent(issue, reason) {
  if (String(GOOGLE_CALENDAR_ENABLED).toLowerCase() !== 'true' || !GOOGLE_CALENDAR_ID) return;

  const calendar = getGoogleCalendarClient();
  if (!calendar) {
    console.warn('[GOOGLE] Credenciais do Calendar ausentes. Não consegui excluir evento.');
    return;
  }

  const event = await findCalendarEventForIssue(calendar, issue);
  if (!event?.id) {
    const meet = getCustomValue(issue, GOOGLE_MEET_FIELD_NAME);
    if (meet) await updateIssueCustomField(issue, GOOGLE_MEET_FIELD_NAME, '');
    return;
  }

  try {
    await calendar.events.delete({ calendarId: GOOGLE_CALENDAR_ID, eventId: event.id });
    console.log(`[GOOGLE] Evento da issue #${issue.id} excluído (${reason}).`);
    if (redis) {
      await redis.del(getCalendarRedisKey(issue.id));
      await redis.del(`redmine:issue:${issue.id}:calendar-signature`);
    }
    await updateIssueCustomField(issue, GOOGLE_MEET_FIELD_NAME, '');
  } catch (err) {
    if (err.response?.status === 404 || err.code === 404) {
      if (redis) await redis.del(getCalendarRedisKey(issue.id));
      await updateIssueCustomField(issue, GOOGLE_MEET_FIELD_NAME, '');
      return;
    }
    console.error(`[GOOGLE] Falha ao excluir evento da issue #${issue.id}:`, err.response?.data || err.message);
  }
}

function buildCalendarEventRequest(issue, start, estimatedHours) {
  const end = start.add(estimatedHours, 'hour');
  const projectName = getCustomValue(issue, GOOGLE_MEET_PROJECT_FIELD_NAME);
  const summary = `${projectName ? projectName + ' - ' : ''}#${issue.id} ${issue.subject}`;

  return {
    summary,
    description: `${formatIssueLine(issue)}`,
    start: { dateTime: start.toISOString(), timeZone: TZ },
    end: { dateTime: end.toISOString(), timeZone: TZ },
    extendedProperties: {
      private: {
        redmineIssueId: String(issue.id)
      }
    }
  };
}

async function ensureCalendarEvent(issue) {
  if (String(GOOGLE_CALENDAR_ENABLED).toLowerCase() !== 'true') return;
  if (!GOOGLE_CALENDAR_ID) {
    console.warn('[GOOGLE] GOOGLE_CALENDAR_ID ausente.');
    return;
  }

  const calendar = getGoogleCalendarClient();
  if (!calendar) {
    console.warn('[GOOGLE] Credenciais do Calendar ausentes. Não sincronizei evento.');
    return;
  }

  const signature = getCalendarSignature(issue);

  if (!signature) {
    await clearCalendarEvent(issue, 'faltam requisitos: status Aguardando Data, Horário ou Tempo estimado');
    return;
  }

  const start = parseIssueDateTime(issue);
  const estimatedHours = Number(issue.estimated_hours);
  const cachedSignatureKey = `redmine:issue:${issue.id}:calendar-signature`;
  const cachedSignature = redis ? await redis.get(cachedSignatureKey) : '';

  const existingEvent = await findCalendarEventForIssue(calendar, issue);
  const eventBody = buildCalendarEventRequest(issue, start, estimatedHours);

  if (existingEvent?.id) {
    if (cachedSignature === signature) {
      logSkip(`#${issue.id}`, 'evento do Google Calendar já sincronizado.');
      return;
    }

    try {
      const response = await calendar.events.patch({
        calendarId: GOOGLE_CALENDAR_ID,
        eventId: existingEvent.id,
        conferenceDataVersion: 1,
        requestBody: eventBody
      });

      const meetLink = getMeetLinkFromCalendarEvent(response.data) || getCustomValue(issue, GOOGLE_MEET_FIELD_NAME);
      if (meetLink && meetLink !== getCustomValue(issue, GOOGLE_MEET_FIELD_NAME)) {
        await updateIssueCustomField(issue, GOOGLE_MEET_FIELD_NAME, meetLink);
      }

      if (redis) {
        await redis.set(getCalendarRedisKey(issue.id), existingEvent.id, 'EX', ttlSeconds);
        await redis.set(cachedSignatureKey, signature, 'EX', ttlSeconds);
      }

      console.log(`[GOOGLE] Evento atualizado para issue #${issue.id}: ${start.format('DD/MM/YYYY HH:mm')} (${estimatedHours}h).`);
      return;
    } catch (err) {
      console.error(`[GOOGLE] Falha ao atualizar evento da issue #${issue.id}:`, err.response?.data || err.message);
      return;
    }
  }

  const createLockKey = `redmine:issue:${issue.id}:calendar-create-lock`;
  const first = await redisSetOnce(createLockKey, '1', 5 * 60);
  if (!first) return;

  try {
    const response = await calendar.events.insert({
      calendarId: GOOGLE_CALENDAR_ID,
      conferenceDataVersion: 1,
      requestBody: {
        ...eventBody,
        conferenceData: {
          createRequest: {
            requestId: `redmine-${issue.id}-${Date.now()}`,
            conferenceSolutionKey: { type: 'hangoutsMeet' }
          }
        }
      }
    });

    const meetLink = getMeetLinkFromCalendarEvent(response.data);
    console.log(`[GOOGLE] Evento criado para issue #${issue.id}${meetLink ? `: ${meetLink}` : ''}`);

    if (meetLink) {
      await updateIssueCustomField(issue, GOOGLE_MEET_FIELD_NAME, meetLink);
    }

    if (redis) {
      await redis.set(getCalendarRedisKey(issue.id), response.data?.id || '1', 'EX', ttlSeconds);
      await redis.set(cachedSignatureKey, signature, 'EX', ttlSeconds);
      await redis.del(createLockKey);
    }
  } catch (err) {
    console.error('[GOOGLE] Falha ao criar evento:', err.response?.data || err.message);
    if (redis) await redis.del(createLockKey);
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

function getLastJournalUpdatedAt(issue) {
  const journalDates = (issue.journals || [])
    .map(j => dayjs(j.created_on || j.updated_on))
    .filter(d => d.isValid());

  if (journalDates.length) {
    return journalDates.reduce((latest, current) => current.isAfter(latest) ? current : latest);
  }

  const updated = dayjs(issue.updated_on);
  return updated.isValid() ? updated : null;
}

async function fetchChangedIssuesForCalendar() {
  const minutesBack = Math.max(30, Math.ceil(getDynamicPollingIntervalInSeconds() / 60) + 10);
  const fallbackSince = dayjs().subtract(minutesBack, 'minute');
  const redisKey = 'redmine:calendar-sync:last-scan';
  let since = fallbackSince;

  if (redis) {
    const cached = await redis.get(redisKey);
    const parsed = cached ? dayjs(cached) : null;
    if (parsed?.isValid()) {
      since = parsed.subtract(2, 'minute'); // margem para fuso/latência
    }
  }

  let issues;
  try {
    issues = await fetchRecentIssues({
      status_id: '*',
      updated_on: `>=${since.toISOString()}`
    });
  } catch (err) {
    console.warn('[REDMINE] Filtro updated_on não aceito; usando últimas tarefas alteradas.', err.response?.data || err.message);
    issues = await fetchRecentIssues({ status_id: '*' });
  }

  const nowIso = dayjs().toISOString();
  if (redis) await redis.set(redisKey, nowIso, 'EX', 7 * 24 * 60 * 60);

  return issues.filter(issue => {
    const lastJournal = getLastJournalUpdatedAt(issue);
    if (!lastJournal) return true;
    return lastJournal.isAfter(since) || dayjs(issue.updated_on).isAfter(since);
  });
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

  }

  const changedForCalendar = await fetchChangedIssuesForCalendar();
  for (const issue of changedForCalendar) {
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
