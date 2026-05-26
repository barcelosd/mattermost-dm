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

// Importações do NOVO Motor do WhatsApp (Mais leve, sem Chrome)
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');

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
  MEET_STATUS_NAME = 'Aguardando Data',
  WHATSAPP_GROUP_FIELD_NAME = 'ID Grupo WhatsApp'
} = process.env;

const redmineHeaders = { 'X-Redmine-API-Key': REDMINE_API_KEY, 'Content-Type': 'application/json' };
const mattermostHeaders = { Authorization: `Bearer ${MATTERMOST_TOKEN}`, 'Content-Type': 'application/json' };

// ---------------------------------------------------------
// 1.5 INICIALIZAÇÃO DO WHATSAPP (VIA SOCKETS - LEVE)
// ---------------------------------------------------------
let waSocket = null;

async function initWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('/opt/render/project/src/.wwebjs_auth');
  
  waSocket = makeWASocket({
    auth: state,
    printQRInTerminal: false, // Desligamos o nativo para desenharmos nós mesmos
    logger: pino({ level: 'silent' }), 
    browser: ["Bot NewNorte", "Chrome", "1.0.0"]
  });

  waSocket.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    
    // Desenha o QR Code no console quando estiver disponível
    if (qr) {
      console.log('\n==================================================');
      console.log('[WHATSAPP] Escaneie o QR Code abaixo com o seu celular:');
      qrcode.generate(qr, { small: true });
      console.log('==================================================\n');
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      
      if (shouldReconnect) {
        console.log(`[WHATSAPP] Conexão caiu (Timeout/Erro). Tentando de novo em 5s...`);
        // Adicionado um pequeno freio para não estressar o servidor
        setTimeout(initWhatsApp, 5000); 
      } else {
        console.log('[WHATSAPP] Desconectado permanentemente (Logout). Apague o disco para novo QR.');
      }
    } else if (connection === 'open') {
      console.log('[WHATSAPP] Conectado com sucesso via WebSockets!');
    }
  });

  // Salva as credenciais no disco automaticamente
  waSocket.ev.on('creds.update', saveCreds);

  // Escuta os comandos (como o !id)
  waSocket.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    const msg = messages[0];
    if (!msg.message) return;
    
    const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
    const comando = text?.trim().toLowerCase();

    if (comando === '!id') {
      try {
        const chatId = msg.key.remoteJid;
        await waSocket.sendMessage(chatId, { 
          text: `🤖 *Bot NewNorte*\n\nO ID deste grupo/conversa é:\n*${chatId}*\n\n_Copie esse código inteiro e cole no Redmine._` 
        });
      } catch (error) {
        console.error('[ERRO WHATSAPP] Falha ao enviar ID:', error.message);
      }
    }
  });
}

// Inicia o serviço
initWhatsApp();

// ---------------------------------------------------------
// 2. CACHE E REDIS
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
// 3. UTILITÁRIOS E DATAS
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
  const timeValueRaw = getCustomFieldValue(issue, ALERT_FIELD_NAME);
  if (!date || !timeValueRaw) return null;
  const timeValue = String(timeValueRaw).trim().toLowerCase().replace(/\s+/g, '');
  let parsedTime = dayjs(timeValue, ['HH:mm', 'HHhmm', 'HHh'], false);
  if (!parsedTime.isValid()) return null;
  const dateTime = dayjs.tz(`${date} ${parsedTime.format('HH:mm')}`, "YYYY-MM-DD HH:mm", "America/Sao_Paulo").toDate();
  return { dateTime, timeLabel: parsedTime.format('HH[h]mm') };
}

function getEstimatedMinutes(issue) {
  const hours = Number(String(issue.estimated_hours || 0).replace(',', '.'));
  return (!hours || Number.isNaN(hours)) ? null : Math.round(hours * 60);
}

function isDailySummaryTime() {
  if (DAILY_SUMMARY_ENABLED !== 'true') return false;
  const now = dayjs().tz('America/Sao_Paulo');
  const day = now.day(); 
  if (day === 0 || day === 6) return false;
  return now.hour() === Number(DAILY_SUMMARY_HOUR) && now.minute() === Number(DAILY_SUMMARY_MINUTE);
}

function getNextBusinessSummaryDateString() {
  let target = dayjs().tz('America/Sao_Paulo');
  if (target.day() === 5) {
    target = target.add(3, 'day');
  } else {
    target = target.add(1, 'day');
  }
  return target.format('YYYY-MM-DD');
}

// ---------------------------------------------------------
// 4. INTEGRAÇÕES API
// ---------------------------------------------------------
async function updateRedmineCustomField(issue, fieldName, value) {
  const fieldId = getCustomFieldId(issue, fieldName);
  if (!fieldId) return;
  await axios.put(`${REDMINE_URL}/issues/${issue.id}.json`, { issue: { custom_fields: [{ id: fieldId, value }] } }, { headers: redmineHeaders });
  setCustomFieldValue(issue, fieldName, value);
}
async function getRedmineProject(projectId) {
  if (!projectId) return null;
  try {
    const response = await axios.get(`${REDMINE_URL}/projects/${projectId}.json`, { headers: redmineHeaders });
    return response.data.project;
  } catch { return null; }
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
    } catch (error) {}
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
  const project = await getRedmineProject(issue.project.id);
  return getCustomFieldValue(project, GOOGLE_MEET_PROJECT_FIELD_NAME) || project?.parent?.name || project?.name || issue.project?.name || '';
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
    if (eventId) {
      await calendar.events.delete({ calendarId: GOOGLE_CALENDAR_ID, eventId });
    }
  } catch (error) {
  } finally {
    await redisDel(`redmine:meet:event:${issueId}`);
    await redisDel(`redmine:meet:signature:${issueId}`);
    await redisDel(`redmine:meet:link:${issueId}`);
    await redisSetRemove('redmine:meet:issues', String(issueId));
  }
}

async function processGoogleMeet(issue) {
  if (!googleCalendarIsConfigured()) return;
  const isMeet = isMeetStatus(issue);
  const appointment = parseAppointmentDateTime(issue);
  const estimatedMinutes = getEstimatedMinutes(issue);

  if (!isMeet || !appointment || !estimatedMinutes) {
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

  try {
    if (eventId) {
      const response = await calendar.events.patch({ calendarId: GOOGLE_CALENDAR_ID, eventId, conferenceDataVersion: 1, requestBody });
      event = response.data;
    } else {
      const response = await calendar.events.insert({
        calendarId: GOOGLE_CALENDAR_ID, conferenceDataVersion: 1,
        requestBody: { ...requestBody, conferenceData: { createRequest: { requestId: `redmine-${issue.id}-${Date.now()}`, conferenceSolutionKey: { type: 'hangoutsMeet' } } } }
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
  } catch (error) {}
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
    `### ⏰ Lembrete de Reunião`, ``, `Faltam **${alertMinutes} minutos** para o compromisso da tarefa **#${issue.id}**.`, ``,
    `**Projeto:** ${issue.project?.name || ''}`, `**Assunto:** ${issue.subject}`, `**Horário:** ${timeLabel}`,
    meetLink ? `**Link do Google Meet:** ${meetLink}` : null, ``, `[Abrir tarefa no Redmine](${REDMINE_URL}/issues/${issue.id})`
  ].filter(Boolean).join('\n');
}

function buildWhatsAppMessage(issue, alertMinutes, timeLabel) {
  const meetLink = getCustomFieldValue(issue, 'Google Meet');
  let msg = `⏰ *Lembrete de Reunião*\n\n`;
  msg += `Faltam *${alertMinutes} minutos* para a reunião da tarefa #${issue.id}.\n\n`;
  msg += `*Projeto:* ${issue.project?.name || ''}\n`;
  msg += `*Assunto:* ${issue.subject}\n`;
  msg += `*Horário:* ${timeLabel}\n`;
  if (meetLink) msg += `\n*Google Meet:* ${meetLink}\n`;
  msg += `\n🔗 Abrir Tarefa:\n${REDMINE_URL}/issues/${issue.id}`;
  return msg;
}

async function buildDailySummaryLine(issue) {
  const projectName = await getMeetProjectName(issue);
  const horario = getCustomFieldValue(issue, ALERT_FIELD_NAME) || '';
  const meetLink = getCustomFieldValue(issue, 'Google Meet');
  return {
    sort: `${issue.start_date || issue.due_date || ''} ${horario}`,
    text: `- **${horario}**: #${issue.id} - ${projectName} - ${issue.subject}${meetLink ? ` *(Meet: ${meetLink})*` : ''}`
  };
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

    const message = buildAppointmentMessage(issue, alertMinutes, appointment.timeLabel);
    
    // 1. Notifica no Mattermost
    const targets = await getResponsibleTargets(issue);
    if (targets.length > 0) {
      await notifyTargets(targets, message);
    }

    // 2. Notifica no WhatsApp via WebSockets
    if (waSocket) {
      const project = await getRedmineProject(issue.project?.id);
      const groupId = getCustomFieldValue(project, WHATSAPP_GROUP_FIELD_NAME);
      
      if (groupId) {
        try {
          const cleanGroupId = String(groupId).trim();
          const whatsAppMsg = buildWhatsAppMessage(issue, alertMinutes, appointment.timeLabel);
          
          // O Baileys envia usando um objeto { text: ... }
          await waSocket.sendMessage(cleanGroupId, { text: whatsAppMsg });
          console.log(`[WHATSAPP] Alerta de ${alertMinutes}m enviado para o grupo ${cleanGroupId}`);
        } catch (err) {
          console.error(`[ERRO WHATSAPP] Falha ao enviar para ${groupId}:`, err.message);
        }
      }
    }

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
// 7. POLLING DE ATUALIZAÇÕES E BUSCAS DE API
// ---------------------------------------------------------
let lastPollingTimestamp = Date.now() - 10 * 60 * 1000;

async function fetchRecentIssues() {
  const response = await axios.get(`${REDMINE_URL}/issues.json`, {
    headers: redmineHeaders,
    params: { status_id: '*', sort: 'updated_on:desc', limit: Number(POLLING_LIMIT) }
  });
  return response.data.issues || [];
}

async function pollingRedmineIssues() {
  try {
    const issues = await fetchRecentIssues();
    for (const issueSummary of issues) {
      const updatedAt = new Date(issueSummary.updated_on).getTime();
      if (updatedAt < lastPollingTimestamp) continue;
      try {
        const issue = await fetchIssueDetails(issueSummary.id);
        const issueWithUrl = { ...issue, url: `${REDMINE_URL}/issues/${issue.id}` };
        await processGoogleMeet(issueWithUrl);
        const lastJournal = getLastJournal(issueWithUrl);
        const eventKey = getEventKey(issueWithUrl, 'Polling', lastJournal);
        if (!(await wasAlreadyNotified(eventKey))) {
          await processIssueNotification(issueWithUrl, 'Atualização', 'Polling', lastJournal);
        }
      } catch (errorIssue) {
        if (errorIssue.response?.status === 404) await deleteGoogleMeet(issueSummary.id);
      }
    }
    lastPollingTimestamp = Date.now();
  } catch (error) {}
}

async function fetchIssuesByDate(dateStr) {
  try {
    const [resStart, resDue] = await Promise.all([
      axios.get(`${REDMINE_URL}/issues.json`, { headers: redmineHeaders, params: { status_id: '*', start_date: dateStr, limit: 100 } }).catch(() => ({ data: { issues: [] } })),
      axios.get(`${REDMINE_URL}/issues.json`, { headers: redmineHeaders, params: { status_id: '*', due_date: dateStr, limit: 100 } }).catch(() => ({ data: { issues: [] } }))
    ]);
    const combined = [...(resStart.data.issues || []), ...(resDue.data.issues || [])];
    const unique = Array.from(new Map(combined.map(i => [i.id, i])).values());
    return unique;
  } catch (error) { return []; }
}

async function pollingAppointmentAlerts() {
  try {
    const today = dayjs().tz('America/Sao_Paulo').format('YYYY-MM-DD');
    const issues = await fetchIssuesByDate(today);
    for (const issueSummary of issues) {
      try {
        const issue = await fetchIssueDetails(issueSummary.id);
        const issueWithUrl = { ...issue, url: `${REDMINE_URL}/issues/${issue.id}` };
        await checkAppointmentAlert(issueWithUrl);
      } catch (err) {}
    }
  } catch (error) {}
}

// ---------------------------------------------------------
// 9. RESUMO DIÁRIO E FAXINA
// ---------------------------------------------------------
async function processDailySummary() {
  if (!isDailySummaryTime()) return;
  const targetDate = getNextBusinessSummaryDateString();
  const summaryKey = `redmine:daily-summary:${targetDate}`;
  if (await wasAlreadyNotified(summaryKey)) return;

  try {
    const issueSummaries = await fetchIssuesByDate(targetDate);
    const groupedByEmail = new Map();
    for (const issueSummary of issueSummaries) {
      if (shouldIgnoreIssueByStatus(issueSummary)) continue;
      const issue = await fetchIssueDetails(issueSummary.id);
      const horario = getCustomFieldValue(issue, ALERT_FIELD_NAME);
      if (!horario) continue;
      const targets = await getResponsibleTargets(issue);
      if (!targets.length) continue;
      const line = await buildDailySummaryLine(issue);
      for (const target of targets) {
        if (!groupedByEmail.has(target.email)) {
          groupedByEmail.set(target.email, { target, lines: [] });
        }
        groupedByEmail.get(target.email).lines.push(line);
      }
    }
    for (const { target, lines } of groupedByEmail.values()) {
      lines.sort((a, b) => a.sort.localeCompare(b.sort));
      const message = [`### 📅 Resumo de Compromissos (Próximo Dia Útil)`, ``, `Data: **${dayjs(targetDate).format('DD/MM/YYYY')}**`, ``, ...lines.map(l => l.text)].join('\n');
      await notifyTargets([target], message);
    }
    await markAsNotified(summaryKey);
  } catch (error) {}
}

async function reconcileDeletedMeets() {
  try {
    const meetIssueIds = await redisSetMembers('redmine:meet:issues');
    for (const issueId of meetIssueIds) {
      try { await axios.get(`${REDMINE_URL}/issues/${issueId}.json`, { headers: redmineHeaders }); } 
      catch (err) { if (err.response?.status === 404) await deleteGoogleMeet(issueId); }
    }
  } catch (error) {}
}

async function fetchIssueDetails(issueId) {
  const response = await axios.get(`${REDMINE_URL}/issues/${issueId}.json`, { headers: redmineHeaders, params: { include: 'journals' } });
  return response.data.issue;
}

// ---------------------------------------------------------
// 10. SMART SCHEDULER
// ---------------------------------------------------------
function getDynamicInterval(baseIntervalSeconds) {
  const now = dayjs().tz('America/Sao_Paulo');
  const day = now.day();
  const hour = now.hour();
  const minute = now.minute();
  const second = now.second();
  const msSinceMidnight = (hour * 3600 + minute * 60 + second) * 1000;

  const ONE_HOUR_MS = 60 * 60 * 1000;
  const LUNCH_BREAK_MS = 5 * 60 * 1000;
  const BASE_MS = Number(baseIntervalSeconds) * 1000;

  if (day === 0 || day === 6) return ONE_HOUR_MS;

  const shift1Start = 7.75 * 3600 * 1000; 
  const shift1End = 12 * 3600 * 1000;
  const shift2Start = 13.25 * 3600 * 1000; 
  const shift2End = 19 * 3600 * 1000; 

  let targetInterval = BASE_MS;
  if (msSinceMidnight < shift1Start || msSinceMidnight >= shift2End) { targetInterval = ONE_HOUR_MS; } 
  else if (msSinceMidnight >= shift1End && msSinceMidnight < shift2Start) { targetInterval = LUNCH_BREAK_MS; }

  const boundaries = [shift1Start, shift1End, shift2Start, shift2End];
  for (const boundary of boundaries) {
    if (msSinceMidnight < boundary) {
      const msUntilBoundary = boundary - msSinceMidnight;
      if (targetInterval > msUntilBoundary) targetInterval = msUntilBoundary;
      break; 
    }
  }
  return Math.max(targetInterval, BASE_MS);
}

function startSmartPolling(taskFn, baseIntervalSeconds, taskName) {
  async function run() {
    try { await taskFn(); } catch (err) {} 
    finally {
      const nextInterval = getDynamicInterval(baseIntervalSeconds);
      if (nextInterval > (baseIntervalSeconds * 1000)) {
        const nextTime = dayjs().add(nextInterval, 'ms').tz('America/Sao_Paulo').format('HH:mm:ss');
        console.log(`[ECONOMIA] ${taskName} em repouso. Desperta pontualmente às ${nextTime}`);
      }
      setTimeout(run, nextInterval);
    }
  }
  setTimeout(run, 5000);
}

const app = express();

app.get('/polling-now', async (req, res) => {
  await pollingRedmineIssues();
  await pollingAppointmentAlerts();
  await processDailySummary(); 
  await reconcileDeletedMeets();
  res.json({ success: true, message: 'Processo completo forçado com sucesso.' });
});

app.get('/', (req, res) => { res.send('API Bot - Precisão Máxima e WhatsApp Ativos (Motor Leve).'); });

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}. Smart Scheduler inicializado.`);
  
  if (String(POLLING_ENABLED) === 'true') {
    startSmartPolling(pollingRedmineIssues, POLLING_INTERVAL_SECONDS, 'Atualizações');
    startSmartPolling(pollingAppointmentAlerts, ALERT_POLLING_INTERVAL_SECONDS, 'Alertas');
    startSmartPolling(reconcileDeletedMeets, 900, 'Faxina');
    setInterval(processDailySummary, 60000);
  }
});