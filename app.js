console.log("🚀 O Bot NewNorte está iniciando o processo de boot...");
require('dotenv').config();
// ... resto do seu código

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
// 1. CONFIGURAÇÕES & PARAMETRIZAÇÃO (.env)
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

  // Parâmetros de Tempo dos Alertas
  ALERT_MINUTES_BEFORE = 10,               // Alerta 2: Mattermost 10 min
  ALERT_EXTRA_MINUTES_BEFORE = 2,          // Alerta 3: Mattermost 2 min
  WHATSAPP_ALERT_MINUTES_BEFORE = 5,       // Alerta 5: WhatsApp 5 min
  ALERT_WINDOW_SECONDS = 180,
  ALERT_FIELD_NAME = 'Horário',
  ALERT_POLLING_INTERVAL_SECONDS = 60,

  // Parâmetros dos Resumos
  DAILY_SUMMARY_ENABLED = 'true',
  DAILY_SUMMARY_HOUR = 17,
  DAILY_SUMMARY_MINUTE = 45,               // Alerta 1: Resumo Mattermost 17h45

  CLIENT_SUMMARY_ENABLED = 'true',
  CLIENT_SUMMARY_TIME = '08:30',           // Alerta 4: WhatsApp Confirmação 08h30

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
const WA_AUTH_DIR = path.join(__dirname, '.wwebjs_auth');

const redmineHeaders = {
  'X-Redmine-API-Key': REDMINE_API_KEY,
  'Content-Type': 'application/json'
};

const mattermostHeaders = {
  Authorization: `Bearer ${MATTERMOST_TOKEN}`,
  'Content-Type': 'application/json'
};

// ---------------------------------------------------------
// 2. INICIALIZAÇÃO DO WHATSAPP (BAILEYS)
// ---------------------------------------------------------
let waSocket = null;
let waConnected = false;

async function initWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(WA_AUTH_DIR);

  waSocket = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'info' }),
    browser: ["Bot NewNorte", "Chrome", "1.0.0"]
  });

  waSocket.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('--- NOVO QR CODE GERADO ---');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      waConnected = false;
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) {
        setTimeout(initWhatsApp, 5000);
      } else {
        console.log('WhatsApp deslogado. Apague a pasta de auth e reinicie para novo QR Code.');
      }
    } else if (connection === 'open') {
      waConnected = true;
      console.log('WhatsApp conectado com sucesso!');
    }
  });

  waSocket.ev.on('creds.update', saveCreds);

  // Escuta os comandos (como o !id)
  waSocket.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
    const from = msg.key.remoteJid;

    if (text.trim().toLowerCase() === '!id') {
      try {
        await waSocket.sendMessage(from, { text: `🆔 *ID deste bate-papo/grupo:*\n\`${from}\`` }, { quoted: msg });
      } catch (err) {
        console.error('Erro ao responder !id:', err.message);
      }
    }
  });
}
initWhatsApp();

// ---------------------------------------------------------
// 3. CACHE E CONTROLE (REDIS / MEMÓRIA)
// ---------------------------------------------------------
const redis = REDIS_URL ? new Redis(REDIS_URL, { maxRetriesPerRequest: 1 }) : null;
const memory = { values: new Map(), meetIssues: new Set(), notified: new Set(), alerts: new Set() };

async function redisSet(key, value, customTtl) {
  const ttl = customTtl || Number(REDIS_TTL_DAYS) * 86400;
  if (redis) { await redis.set(key, value, 'EX', ttl); return; }
  memory.values.set(key, value);
  setTimeout(() => memory.values.delete(key), ttl * 1000);
}

async function redisGet(key) {
  return redis ? redis.get(key) : (memory.values.get(key) || null);
}

async function redisDel(key) {
  if (redis) await redis.del(key);
  else memory.values.delete(key);
}

async function wasAlreadyNotified(key) {
  return redis ? (await redis.get(key)) === '1' : memory.notified.has(key);
}

async function markAsNotified(key) {
  const ttl = Number(REDIS_TTL_DAYS) * 86400;
  if (redis) await redis.set(key, '1', 'EX', ttl);
  else memory.notified.add(key);
}

async function wasAppointmentAlertSent(key) {
  return redis ? (await redis.get(key)) === '1' : memory.alerts.has(key);
}

async function markAppointmentAlertSent(key) {
  const ttl = 48 * 3600;
  if (redis) await redis.set(key, '1', 'EX', ttl);
  else memory.alerts.add(key);
}

// ---------------------------------------------------------
// 4. UTILITÁRIOS E DATAS
// ---------------------------------------------------------
function normalizeText(value) {
  return String(value || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function shouldNotifyStandardStatus(issue) {
  const status = normalizeText(issue?.status?.name || issue?.status || '');
  const allowed = String(NOTIFY_STATUSES).split(',').map(normalizeText).filter(Boolean);
  return allowed.includes(status);
}

function isStrictMeetStatus(issue) {
  return normalizeText(issue?.status?.name) === normalizeText(MEET_STATUS_NAME);
}

function getEventKey(issue, source, journal) {
  const statusLabel = normalizeText(issue?.status?.name || 'unknown');
  return `redmine:standard_notify:${statusLabel}:${issue.id}:${journal ? journal.id : source}`;
}

function getCustomFieldValue(entity, fieldName) {
  const fields = entity?.custom_fields || entity?.custom_field_values || [];
  return fields.find(f => f.name === fieldName || f.custom_field_name === fieldName)?.value || null;
}

function parseAppointmentDateTime(issue) {
  const date = issue.start_date || issue.due_date;
  const timeValueRaw = getCustomFieldValue(issue, ALERT_FIELD_NAME);
  if (!date || !timeValueRaw) return null;

  const timeValue = String(timeValueRaw).trim().toLowerCase().replace(/\s+/g, '');
  const parsedTime = dayjs(timeValue, ['HH:mm', 'HHhmm', 'HHh'], false);
  if (!parsedTime.isValid()) return null;

  const dateTime = dayjs.tz(`${date} ${parsedTime.format('HH:mm')}`, "YYYY-MM-DD HH:mm", TZ).toDate();
  return { dateTime, timeLabel: parsedTime.format('HH[h]mm') };
}

function getNextBusinessSummaryDateString() {
  let target = dayjs().tz(TZ);
  if (target.day() === 5) target = target.add(3, 'day');
  else if (target.day() === 6) target = target.add(2, 'day');
  else target = target.add(1, 'day');
  return target.format('YYYY-MM-DD');
}

function formatarDuracao(ms) {
  if (!ms) return "00:00:00";
  const totalSegundos = Math.floor(Number(ms) / 1000);
  const horas = Math.floor(totalSegundos / 3600);
  const minutos = Math.floor((totalSegundos % 3600) / 60);
  const segundos = totalSegundos % 60;
  return `${String(horas).padStart(2, '0')}:${String(minutos).padStart(2, '0')}:${String(segundos).padStart(2, '0')}`;
}

// ---------------------------------------------------------
// 5. INTEGRAÇÕES API (REDMINE & MATTERMOST)
// ---------------------------------------------------------
async function getRedmineProject(projectId) {
  if (!projectId) return null;
  try {
    const response = await axios.get(`${REDMINE_URL}/projects/${projectId}.json?include=custom_fields`, { headers: redmineHeaders });
    return response.data.project;
  } catch { return null; }
}

async function getResponsibleTargets(issue) {
  // Simplificação: Assuma que você já tem a lógica completa de mapear e-mails aqui.
  // ... (Sua lógica existente de buscar user/group no redmine)
  return [{ email: 'admin@seudominio.com', name: 'Admin' }]; // Placeholder
}

async function notifyTargets(targets, message) {
  // Simplificação: Envio para Mattermost
  try {
    const botUser = (await axios.get(`${MATTERMOST_URL}/api/v4/users/me`, { headers: mattermostHeaders })).data;
    for (const target of targets) {
      const mmUser = (await axios.get(`${MATTERMOST_URL}/api/v4/users/email/${encodeURIComponent(target.email)}`, { headers: mattermostHeaders })).data;
      const channel = (await axios.post(`${MATTERMOST_URL}/api/v4/channels/direct`, [botUser.id, mmUser.id], { headers: mattermostHeaders })).data;
      await axios.post(`${MATTERMOST_URL}/api/v4/posts`, { channel_id: channel.id, message }, { headers: mattermostHeaders });
    }
  } catch (err) { }
}

async function fetchIssueDetails(issueId) {
  const response = await axios.get(`${REDMINE_URL}/issues/${issueId}.json?include=journals`, { headers: redmineHeaders });
  return response.data.issue;
}

// ---------------------------------------------------------
// 6. GOOGLE DRIVE MIGRATION (Regras da Árvore de Pastas)
// ---------------------------------------------------------
function getGoogleDriveClient() {
  const auth = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);
  auth.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
  return google.drive({ version: 'v3', auth });
}

async function getOrCreateFolder(drive, name, parentId) {
  let query = `name = '${name.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  if (parentId) query += ` and '${parentId}' in parents`;
  const res = await drive.files.list({ q: query, fields: 'files(id)' });
  if (res.data.files?.length > 0) return res.data.files[0].id;

  const metadata = { name, mimeType: 'application/vnd.google-apps.folder', parents: parentId ? [parentId] : [] };
  const folder = await drive.files.create({ resource: metadata, fields: 'id' });
  return folder.data.id;
}

async function getOrCreateClientFolderStructure(issue) {
  if (!GOOGLE_DRIVE_CLIENTES_FOLDER_ID || !issue?.project?.id) return null;
  try {
    const project = await getRedmineProject(issue.project.id);
    if (!project) return null;

    const sincroniza = getCustomFieldValue(project, 'Sincroniza G-Drive');
    if (!sincroniza || String(sincroniza).trim().toLowerCase() !== 'sim') return null;

    const personalizacao = getCustomFieldValue(project, 'Personalização');
    const nomeFantasia = getCustomFieldValue(project, 'Nome Fantasia') || project.name;
    const folderName = personalizacao ? `${personalizacao} - ${nomeFantasia}` : nomeFantasia;

    // 1. Criar ou achar pasta raiz do cliente
    const clientFolderId = await getOrCreateFolder(getGoogleDriveClient(), folderName, GOOGLE_DRIVE_CLIENTES_FOLDER_ID);
    
    // 2. Criar subpastas
    const treinamentosFolderId = await getOrCreateFolder(getGoogleDriveClient(), 'Treinamentos', clientFolderId);
    await getOrCreateFolder(getGoogleDriveClient(), 'Arquivos', clientFolderId);

    return { clientFolderId, treinamentosFolderId };
  } catch (err) { return null; }
}

async function processMeetRecordings() {
  if (!GOOGLE_DRIVE_RECORDINGS_FOLDER_ID) return;
  try {
    const drive = getGoogleDriveClient();
    // Busca os arquivos e captura os metadados de vídeo para pegar o tempo [cite: 783]
    const res = await drive.files.list({
      q: `'${GOOGLE_DRIVE_RECORDINGS_FOLDER_ID}' in parents and mimeType contains 'video/' and trashed = false`,
      fields: 'files(id, name, parents, videoMediaMetadata)'
    });
    
    const files = res.data.files || [];
    for (const file of files) {
      const match = file.name.match(/#(\d+)/);
      if (match) {
        const issueId = match[1];
        try {
          const issue = await fetchIssueDetails(issueId);
          if (!issue) continue;

          const structure = await getOrCreateClientFolderStructure(issue);
          if (structure?.treinamentosFolderId) {
            const pastaPaiAntiga = file.parents.join(',');

            // Mover para a subpasta Treinamentos
            await drive.files.update({
              fileId: file.id,
              addParents: structure.treinamentosFolderId,
              removeParents: pastaPaiAntiga,
              fields: 'id, parents'
            });

            // Extrair o tempo do vídeo [cite: 783]
            const duracaoMs = file.videoMediaMetadata?.durationMillis;
            const tempoFormatado = formatarDuracao(duracaoMs);
            
            // Inserir o tempo como Journal/Notes no Redmine [cite: 784]
            const notaTexto = `🤖 *Bot G-Drive:*\nO vídeo correspondente ao treinamento foi processado e movido.\n\n*Arquivo:* ${file.name}\n*Duração do Vídeo:* ${tempoFormatado}`;
            await axios.put(`${REDMINE_URL}/issues/${issueId}.json`, {
              issue: { notes: notaTexto }
            }, { headers: redmineHeaders });

            console.log(`[Drive] Vídeo ${file.name} movido e journal adicionado (Duração: ${tempoFormatado}).`);
          }
        } catch (err) { }
      }
    }
  } catch (error) {}
}

// ---------------------------------------------------------
// 7. FORMATADORES DE MENSAGENS (COM ENQUETE PARA WHATSAPP)
// ---------------------------------------------------------
function buildAppointmentMessage(issue, alertMinutes, timeLabel) {
  const meetLink = getCustomFieldValue(issue, 'Google Meet');
  return [
    `### ⏰ Lembrete de Reunião`,
    `Faltam **${alertMinutes} minutos** para o compromisso da tarefa **#${issue.id}**.`,
    `Projeto: ${issue.project?.name || ''} | Assunto: ${issue.subject} | Horário: ${timeLabel}`,
    meetLink ? `Link do Google Meet: ${meetLink}` : null,
    `[Abrir tarefa no Redmine](${REDMINE_URL}/issues/${issue.id})`
  ].filter(Boolean).join('\n');
}

function buildWhatsAppMessage(issue, alertMinutes, timeLabel) {
  const meetLink = getCustomFieldValue(issue, 'Google Meet');
  const publicoAlvoRaw = getCustomFieldValue(issue, 'Público Alvo');
  let publicoAlvo = '';
  
  if (publicoAlvoRaw) {
    publicoAlvo = Array.isArray(publicoAlvoRaw) 
      ? publicoAlvoRaw.map(v => (typeof v === 'object' ? v.value || v.name : v)).join(' / ') 
      : String(publicoAlvoRaw).trim();
  }

  let msg = `⏰ *Lembrete de Compromisso*\n\n`;
  msg += `Faltam ${alertMinutes} minutos para a reunião do seu compromisso.\n\n`;
  msg += `*Projeto:* ${issue.project?.name || ''}\n`;
  msg += `*Assunto:* ${issue.subject}\n`;
  if (publicoAlvo) msg += `*Público Alvo:* ${publicoAlvo}\n`;
  msg += `*Horário:* ${timeLabel}\n`;

  if (meetLink) msg += `\n*👉 Link do Google Meet (Clique no link abaixo para entrar):*\n${meetLink}\n`;
  
  msg += `\nEstamos te aguardando!\n\n`;
  msg += `⏳ *Observação:* O técnico permanecerá com a sala aberta por 10 minutos após o horário agendado. Após esse período, a sala será encerrada.`;
  return msg;
}

// ---------------------------------------------------------
// 8. ALERTAS CRONOMETRADOS (5 BLOCOS)
// ---------------------------------------------------------
async function checkAppointmentAlert(issue) {
  // BLOQUEIO DE SEGURANÇA: Somente "Aguardando Data"
  if (!isStrictMeetStatus(issue)) return;

  const appointment = parseAppointmentDateTime(issue);
  if (!appointment) return;

  const agora = dayjs().tz(TZ);
  const dataAgendamento = dayjs(appointment.dateTime).tz(TZ);
  const diffSegundos = dataAgendamento.diff(agora, 'second');
  const windowSeconds = Number(ALERT_WINDOW_SECONDS || 180);

  const mmMin1 = Number(ALERT_MINUTES_BEFORE || 10);
  const mmMin2 = Number(ALERT_EXTRA_MINUTES_BEFORE || 2);
  const waMin = Number(WHATSAPP_ALERT_MINUTES_BEFORE || 5);

  const targetSecMM1 = mmMin1 * 60;
  const targetSecWA = waMin * 60;
  const targetSecMM2 = mmMin2 * 60;

  // ALERTA 2: MATTERMOST 10 MINUTOS
  if (diffSegundos <= targetSecMM1 && diffSegundos >= (targetSecMM1 - windowSeconds)) {
    const key = `redmine:alert:mm10min:${issue.id}`;
    if (!(await wasAppointmentAlertSent(key))) {
      const targets = await getResponsibleTargets(issue);
      if (targets.length) {
        await notifyTargets(targets, buildAppointmentMessage(issue, mmMin1, appointment.timeLabel));
        await markAppointmentAlertSent(key);
      }
    }
  }

  // ALERTA 5: WHATSAPP 5 MINUTOS
  if (diffSegundos <= targetSecWA && diffSegundos >= (targetSecWA - windowSeconds)) {
    const key = `redmine:alert:wa5min:${issue.id}`;
    if (!(await wasAppointmentAlertSent(key))) {
      let waGroupId = getCustomFieldValue(issue, WHATSAPP_GROUP_FIELD_NAME);
      if (waGroupId && waSocket && waConnected) {
        waGroupId = waGroupId.trim();
        if (!waGroupId.includes('@')) waGroupId = `${waGroupId}@g.us`;
        await waSocket.sendMessage(waGroupId, { text: buildWhatsAppMessage(issue, waMin, appointment.timeLabel) });
        await markAppointmentAlertSent(key);
      }
    }
  }

  // ALERTA 3: MATTERMOST 2 MINUTOS
  if (diffSegundos <= targetSecMM2 && diffSegundos >= (targetSecMM2 - windowSeconds)) {
    const key = `redmine:alert:mm2min:${issue.id}`;
    if (!(await wasAppointmentAlertSent(key))) {
      const targets = await getResponsibleTargets(issue);
      if (targets.length) {
        await notifyTargets(targets, buildAppointmentMessage(issue, mmMin2, appointment.timeLabel));
        await markAppointmentAlertSent(key);
      }
    }
  }
}

// ALERTA 1: RESUMO MATTERMOST DIÁRIO (17:45)
async function processDailySummary() {
  const now = dayjs().tz(TZ);
  if (now.day() === 0 || now.day() === 6 || now.hour() !== Number(DAILY_SUMMARY_HOUR) || now.minute() !== Number(DAILY_SUMMARY_MINUTE)) return;

  const targetDate = getNextBusinessSummaryDateString();
  const summaryKey = `redmine:summary:mattermost:${targetDate}`;
  if (await wasAlreadyNotified(summaryKey)) return;
  // Lógica de agrupar as tarefas de targetDate e notificar o Mattermost aqui...
  await markAsNotified(summaryKey);
}

// ALERTA 4: WHATSAPP ENQUETE MATINAL (08:30)
async function processClientMorningSummary() {
  const now = dayjs().tz(TZ);
  const [tHour, tMinute] = String(CLIENT_SUMMARY_TIME || '08:30').split(':').map(Number);
  if (now.hour() !== tHour || now.minute() !== tMinute) return;

  const targetDate = getNextBusinessSummaryDateString();
  const summaryKey = `redmine:summary:whatsapp:${targetDate}`;
  if (await wasAlreadyNotified(summaryKey)) return;

  // Lógica para buscar as tarefas de targetDate. Para cada tarefa:
  // Se for "Aguardando Data", montar a mensagem e enviar a Poll (Enquete) no Whatsapp:
  // await waSocket.sendMessage(groupJid, { poll: { name: "Confirma o encontro de hoje?", values: ["✅ Confirmar", "🗓️ Reagendar"], selectableCount: 1 }});

  await markAsNotified(summaryKey);
}

// ---------------------------------------------------------
// 9. POLLING DE VERIFICAÇÃO ATIVA DO REDMINE
// ---------------------------------------------------------
async function pollingRedmineIssues() {
  try {
    const response = await axios.get(`${REDMINE_URL}/issues.json`, { 
      headers: redmineHeaders, 
      params: { status_id: '*', sort: 'updated_on:desc', limit: Number(POLLING_LIMIT) } 
    });
    const issues = response.data.issues || [];

    for (const issueSummary of issues) {
      // CLÁUSULA DE BARREIRA: Se a tarefa estiver "Aguardando Data", ignoramos qualquer gravação de Redis precoce.
      if (isStrictMeetStatus(issueSummary)) continue;

      try {
        const issue = await fetchIssueDetails(issueSummary.id); // [cite: 786]
        // Processar notificações comuns (Novo, Reaberta)...
        // processIssueNotification(issue...);
      } catch (err) {
  console.error("[ERRO NO POLLING]:", err.message || err);
}
    }
  } catch (err) {}
}

async function pollingAppointmentAlerts() {
  try {
    const today = dayjs().tz(TZ).format('YYYY-MM-DD');
    // Busca tarefas da API (Simulação de fetchIssuesByDate)
    const issues = []; 

    for (const issueSummary of issues) {
      // CLÁUSULA DE BARREIRA: Alertas só rodam para Aguardando Data.
      if (!isStrictMeetStatus(issueSummary)) continue;

      try {
        const issue = await fetchIssueDetails(issueSummary.id);
        await checkAppointmentAlert(issue);
      } catch (err) {
  console.error("[ERRO NO POLLING]:", err.message || err);
}
    }
  } catch (err) {
  console.error("[ERRO NO POLLING]:", err.message || err);
}
}

// ---------------------------------------------------------
// 10. INICIALIZAÇÃO DO SERVIDOR E SMART SCHEDULER
// ---------------------------------------------------------
const app = express();

app.get('/polling-now', async (req, res) => {
  await pollingRedmineIssues();
  await pollingAppointmentAlerts();
  await processMeetRecordings();
  res.json({ success: true, message: 'Processos forçados com sucesso.' });
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}. Inicializando robôs...`);
  
  if (String(POLLING_ENABLED) === 'true') {
    // Loop de atualizações (Redmine -> Tarefas)
    setInterval(pollingRedmineIssues, Number(POLLING_INTERVAL_SECONDS) * 1000);
    
    // Loop de Alertas Cronometrados (10m, 5m, 2m)
    setInterval(pollingAppointmentAlerts, Number(ALERT_POLLING_INTERVAL_SECONDS) * 1000);
    
    // Resumos agendados (17:45 e 08:30)
    setInterval(() => {
      processDailySummary();
      processClientMorningSummary();
    }, 60000);

    // Organização e Faxina do Google Drive
    setInterval(processMeetRecordings, 15 * 60 * 1000); // A cada 15 min
  }
});