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
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REFRESH_TOKEN,
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
let sock = null; // Instância do WhatsApp Baileys
let whatsappStarting = false;
let whatsappReconnectTimer = null;
let whatsappSendQueue = Promise.resolve();

// Cache em memória para evitar leituras duplicadas do Redmine no mesmo ciclo.
// Importante: isso reduz consumo do Redmine sem aumentar leitura/gravação no Redis.
let redmineIssuesCache = [];
let redmineIssuesCacheFetchedAt = null;
let lastSuccessfulRedmineFetchAt = null;

// ---------------------------------------------------------
// WHATSAPP - CONEXÃO E ENVIO
// ---------------------------------------------------------
function getWhatsAppAuthDir() {
  // Mantém compatibilidade com a variável já existente no Render.
  // Prioridade: WHATSAPP_AUTH_DIR > WHATSAPP_SESSION_PATH > pasta local padrão.
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
    err.message = `${err.message}. Verifique se o Persistent Disk do Render está montado nesse caminho e se o serviço tem permissão de escrita.`;
    throw err;
  }
}

function getWhatsAppReconnectDelayMs(reason = '') {
  const normalizedReason = String(reason || '').toLowerCase();

  // Erros de permissão/caminho não são resolvidos tentando a cada 5 segundos.
  // Isso evita poluição no log e consumo desnecessário enquanto o mount do Render é corrigido.
  if (
    normalizedReason.includes('eacces') ||
    normalizedReason.includes('eperm') ||
    normalizedReason.includes('permission') ||
    normalizedReason.includes('permissão') ||
    normalizedReason.includes('persistent disk')
  ) {
    return 5 * 60 * 1000;
  }

  return 30 * 1000;
}

function scheduleWhatsAppReconnect(reason = 'desconexão') {
  if (whatsappReconnectTimer) {
    return;
  }

  const delayMs = getWhatsAppReconnectDelayMs(reason);
  const delaySeconds = Math.round(delayMs / 1000);

  console.log(`[WHATSAPP] Reagendando reconexão em ${delaySeconds}s. Motivo: ${reason}.`);

  whatsappReconnectTimer = setTimeout(() => {
    whatsappReconnectTimer = null;
    startWhatsAppConnection().catch(err =>
      console.error('[WHATSAPP] Falha ao reconectar:', err.message)
    );
  }, delayMs);
}

async function startWhatsAppConnection() {
  if (whatsappStarting) {
    console.log('[WHATSAPP] Inicialização já em andamento. Ignorando chamada duplicada.');
    return;
  }

  whatsappStarting = true;

  try {
    const authDir = ensureWritableDirectory(getWhatsAppAuthDir());

    const hasExistingSession = fs.existsSync(path.join(authDir, 'creds.json'));
    console.log(`[WHATSAPP] Diretório de sessão: ${authDir}`);
    console.log(`[WHATSAPP] Sessão existente: ${hasExistingSession ? 'sim' : 'não'}`);

    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
      browser: ['NewNorte Automacoes', 'Chrome', '1.0.0']
    });

    sock.ev.on('creds.update', async () => {
      try {
        await saveCreds();
        console.log('[WHATSAPP] Credenciais atualizadas no diretório de autenticação.');
      } catch (err) {
        console.error('[WHATSAPP] Falha ao salvar credenciais:', err.message);
      }
    });

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log('[WHATSAPP] QR Code gerado. Escaneie para autenticar esta sessão:');
        qrcode.generate(qr, { small: true });
      }

      if (connection === 'connecting') {
        console.log('[WHATSAPP] Conectando...');
      }

      if (connection === 'open') {
        console.log('[WHATSAPP] Conectado com sucesso e pronto para envio.');
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const errorMessage = lastDisconnect?.error?.message || 'sem detalhe';
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        console.log(`[WHATSAPP] Conexão fechada. Status: ${statusCode || 'desconhecido'}. Erro: ${errorMessage}. Reconectar: ${shouldReconnect}.`);

        if (shouldReconnect) {
          scheduleWhatsAppReconnect(`status ${statusCode || 'desconhecido'}`);
        } else {
          console.log('[WHATSAPP] Sessão encerrada pelo WhatsApp. Será necessário escanear o QR Code novamente.');
        }
      }
    });
  } catch (err) {
    console.error('[WHATSAPP] Falha ao iniciar conexão:', err.message);
    scheduleWhatsAppReconnect(err.message || 'falha na inicialização');
  } finally {
    whatsappStarting = false;
  }
}

function normalizeWhatsAppGroupJid(value) {
  const raw = String(value || '').trim();

  if (!raw) {
    return null;
  }

  if (raw.includes('@g.us')) {
    return raw;
  }

  const onlyDigits = raw.replace(/\D/g, '');
  if (onlyDigits) {
    return `${onlyDigits}@g.us`;
  }

  return raw;
}

async function sendWhatsAppMessage(jid, text) {
  const sendTask = async () => {
    if (!sock?.user) {
      console.log('[WHATSAPP] Socket não conectado. Mensagem não enviada.');
      return false;
    }

    try {
      await sock.sendMessage(jid, { text });
      return true;
    } catch (err) {
      console.error(`[WHATSAPP] Falha ao enviar mensagem para ${jid}:`, err.message);
      scheduleWhatsAppReconnect('falha no envio');
      return false;
    }
  };

  // Serializa os envios para reduzir risco de bloqueio/queda por muitos disparos simultâneos.
  whatsappSendQueue = whatsappSendQueue.then(sendTask, sendTask);
  return whatsappSendQueue;
}


// ---------------------------------------------------------
// FUNÇÃO PARA CALCULAR O INTERVALO DINÂMICO DE POLLING
// ---------------------------------------------------------
function getDynamicPollingIntervalInSeconds() {
  const agora = dayjs().tz('America/Sao_Paulo');
  const diaDaSemana = agora.day(); // 0 = Domingo, 1 = Segunda, ..., 6 = Sábado
  const hora = agora.hour();
  const minuto = agora.minute();
  const tempoEmMinutos = hora * 60 + minuto;

  // Finais de semana: baixa atualização, pois não há expediente normal.
  if (diaDaSemana === 0 || diaDaSemana === 6) {
    return Number(WEEKEND_POLLING_INTERVAL_SECONDS) || 3600;
  }

  // Janela de atualização frequente:
  // 07:30-12:15 e 13:15-18:15, conforme expediente/antecedência operacional.
  const inicioManha = 7 * 60 + 30;
  const fimManha = 12 * 60 + 15;
  const inicioTarde = 13 * 60 + 15;
  const fimTarde = 18 * 60 + 15;

  const dentroJanelaFrequente =
    (tempoEmMinutos >= inicioManha && tempoEmMinutos < fimManha) ||
    (tempoEmMinutos >= inicioTarde && tempoEmMinutos < fimTarde);

  if (dentroJanelaFrequente) {
    return Number(POLLING_INTERVAL_SECONDS) || 60;
  }

  // Almoço: reduz bastante, mas ainda verifica algumas alterações.
  const inicioAlmoco = 12 * 60 + 15;
  const fimAlmoco = 13 * 60 + 15;
  if (tempoEmMinutos >= inicioAlmoco && tempoEmMinutos < fimAlmoco) {
    return Number(LUNCH_POLLING_INTERVAL_SECONDS) || 900;
  }

  // Fora do expediente: reduz mais para não sobrecarregar o Redmine.
  return Number(OFF_HOURS_POLLING_INTERVAL_SECONDS) || 1800;
}

function getRedmineHeaders() {
  return { 'X-Redmine-API-Key': REDMINE_API_KEY };
}

function parseIssueDate(issue) {
  const customFields = issue.custom_fields || [];
  const dateField = customFields.find(f => f.name === 'Data');
  const issueDateStr = dateField ? dateField.value : issue.due_date;
  if (!issueDateStr) return null;

  const parsed = dayjs.tz(issueDateStr, 'America/Sao_Paulo');
  return parsed.isValid() ? parsed.startOf('day') : null;
}

function isIssueTodayOrFuture(issue) {
  const hoje = dayjs().tz('America/Sao_Paulo').startOf('day');
  const issueDate = parseIssueDate(issue);
  return issueDate && !issueDate.isBefore(hoje);
}

function upsertCacheById(existingIssues, incomingIssues) {
  const map = new Map();

  for (const issue of existingIssues || []) {
    if (issue && issue.id) map.set(issue.id, issue);
  }

  for (const issue of incomingIssues || []) {
    if (issue && issue.id) map.set(issue.id, issue);
  }

  // Mantém em memória somente o que ainda pode gerar alerta.
  return Array.from(map.values()).filter(issue => {
    const statusName = issue.status ? issue.status.name : '';
    return statusName === MEET_STATUS_NAME || isIssueTodayOrFuture(issue);
  });
}

async function fetchRedmineIssuesOptimized({ force = false } = {}) {
  const agora = dayjs().tz('America/Sao_Paulo');
  const cacheTtl = Number(REDMINE_CACHE_TTL_SECONDS) || 45;

  if (
    !force &&
    redmineIssuesCacheFetchedAt &&
    agora.diff(redmineIssuesCacheFetchedAt, 'second') < cacheTtl
  ) {
    return redmineIssuesCache;
  }

  const limit = Math.max(
    1,
    Math.min(Number(POLLING_LIMIT) || 20, Number(REDMINE_MAX_POLLING_LIMIT) || 20)
  );

  const params = {
    limit,
    sort: 'updated_on:desc',
    status_id: '*'
  };

  // Após a primeira carga, busca só alterações recentes com uma pequena margem.
  // Isso evita reler muitas tarefas antigas em todo ciclo.
  if (lastSuccessfulRedmineFetchAt) {
    const lookback = Number(REDMINE_LOOKBACK_MINUTES) || 10;
    const updatedFrom = lastSuccessfulRedmineFetchAt
      .subtract(lookback, 'minute')
      .format('YYYY-MM-DDTHH:mm:ss');
    params.updated_on = `>=${updatedFrom}`;
  }

  console.log('[REDMINE] Buscando issues com parâmetros enxutos:', JSON.stringify(params));

  const response = await axios.get(`${REDMINE_URL}/issues.json`, {
    headers: getRedmineHeaders(),
    params
  });

  const incomingIssues = response.data.issues || [];
  redmineIssuesCache = upsertCacheById(redmineIssuesCache, incomingIssues);
  redmineIssuesCacheFetchedAt = agora;
  lastSuccessfulRedmineFetchAt = agora;

  console.log(`[REDMINE] Recebidas ${incomingIssues.length} issues; cache ativo com ${redmineIssuesCache.length}.`);
  return redmineIssuesCache;
}

// ---------------------------------------------------------
// POLLING DO REDMINE (TASKS E GESTÃO DE STATUS)
// ---------------------------------------------------------
async function pollingRedmineIssues(issues) {
  console.log('[POLLING] Processando checagem de rotina do Redmine...');

  for (const issue of issues) {
    const statusName = issue.status ? issue.status.name : '';

    // Só avalia o fluxo de notificação imediata dos status configurados.
    const notifyStatuses = String(process.env.NOTIFY_STATUSES || 'Novo,Reaberta')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);

    if (!notifyStatuses.includes(statusName)) {
      continue;
    }

    // Ignora tarefas antigas/sem data quando não há utilidade operacional.
    if (!isIssueTodayOrFuture(issue)) {
      continue;
    }

    // Fluxo normal de validação no Redis e Disparos
    const redisKey = `redmine:issue:${issue.id}:notified:${statusName}`;
    const alreadyNotified = await redis.get(redisKey);

    if (!alreadyNotified) {
      console.log(`[REDMINE] Processando gatilho de notificação para a Task #${issue.id}`);

      // Lógica de envio de mensagem integrada via WhatsApp ou Mattermost aqui...

      // Salva a trava no Redis com expiração configurada para evitar reenvios
      await redis.set(redisKey, 'true', 'EX', Number(REDIS_TTL_DAYS) * 24 * 60 * 60);
    }
  }
}

// ---------------------------------------------------------
// MONITORAMENTO DE ALERTAS DE COMPROMISSOS (APPOINTMENTS)
// ---------------------------------------------------------
function parseIssueAppointmentDateTime(issue) {
  return getIssueAppointmentDateTime(issue);
}

function shouldSendAppointmentAlert(now, appointmentAt, minutesBefore) {
  const alertAt = appointmentAt.subtract(Number(minutesBefore), 'minute');
  const diffSeconds = now.diff(alertAt, 'second');
  const windowSeconds = Math.max(30, Number(ALERT_WINDOW_SECONDS) || 180);

  return diffSeconds >= 0 && diffSeconds <= windowSeconds && appointmentAt.isAfter(now);
}

function buildAppointmentAlertMessage(issue, appointmentAt, minutesBefore) {
  const projeto = issue.project?.name ? ` - ${issue.project.name}` : '';
  const estimativa = formatIssueEstimatedHours(issue);
  const estimatedText = estimativa ? `\nEstimativa: ${estimativa}` : '';
  const issueUrl = `${String(REDMINE_URL).replace(/\/$/, '')}/issues/${issue.id}`;

  return [
    `⏰ **Alerta de compromisso - faltam ${minutesBefore} minutos**`,
    '',
    `Task: **#${issue.id}${projeto}**`,
    `Assunto: ${issue.subject || 'Sem assunto'}`,
    `Data/Hora: ${appointmentAt.format('DD/MM/YYYY HH:mm')}`,
    `Status: ${MEET_STATUS_NAME}${estimatedText}`,
    '',
    issueUrl
  ].join('\n');
}

async function sendMattermostAppointmentAlert(issue, appointmentAt, minutesBefore) {
  const assignedUserId = issue.assigned_to?.id;
  if (!assignedUserId) {
    console.log(`[ALERTAS] Task #${issue.id} sem responsável. Alerta de ${minutesBefore} min ignorado.`);
    return false;
  }

  const redmineUser = await fetchRedmineUserById(assignedUserId);
  const mattermostUser = await findMattermostUserForRedmineUser(redmineUser);

  if (!mattermostUser?.id) {
    console.log(`[ALERTAS] Usuário Mattermost não encontrado para Redmine user #${assignedUserId}.`);
    return false;
  }

  const message = buildAppointmentAlertMessage(issue, appointmentAt, minutesBefore);
  await sendMattermostDirectMessage(mattermostUser.id, message);

  console.log(
    `[ALERTAS] Alerta de ${minutesBefore} min da Task #${issue.id} enviado para ` +
    `${mattermostUser.username || mattermostUser.id}.`
  );

  return true;
}

async function pollingAppointmentAlerts(issues) {
  console.log('[ALERTAS] Processando proximidade de horários...');

  if (!MATTERMOST_URL || !MATTERMOST_TOKEN) {
    console.log('[ALERTAS] Mattermost não configurado. Alertas de compromisso ignorados.');
    return;
  }

  const agora = dayjs().tz('America/Sao_Paulo');
  const hoje = agora.startOf('day');
  const alertMinutes = [
    Number(ALERT_MINUTES_BEFORE) || 10,
    Number(ALERT_EXTRA_MINUTES_BEFORE) || 2
  ].filter((value, index, array) => value > 0 && array.indexOf(value) === index);

  for (const issue of issues) {
    const statusName = issue.status ? issue.status.name : '';
    if (statusName !== MEET_STATUS_NAME) {
      continue;
    }

    const appointmentAt = parseIssueAppointmentDateTime(issue);

    // Ignora sem data/horário, datas antigas e eventos já encerrados.
    if (!appointmentAt || appointmentAt.startOf('day').isBefore(hoje) || !appointmentAt.isAfter(agora)) {
      continue;
    }

    for (const minutesBefore of alertMinutes) {
      if (!shouldSendAppointmentAlert(agora, appointmentAt, minutesBefore)) {
        continue;
      }

      const alertKey = `redmine:appointment:${issue.id}:mattermost-alert:${minutesBefore}min:${appointmentAt.format('YYYYMMDDHHmm')}`;
      const alreadyAlerted = await redis.get(alertKey);

      if (alreadyAlerted) {
        continue;
      }

      try {
        const sent = await sendMattermostAppointmentAlert(issue, appointmentAt, minutesBefore);
        if (sent) {
          await redis.set(alertKey, 'true', 'EX', Number(REDIS_TTL_DAYS) * 24 * 60 * 60);
        }
      } catch (err) {
        console.error(`[ALERTAS] Falha ao enviar alerta de ${minutesBefore} min da Task #${issue.id}:`, err.message);
      }
    }
  }
}

// ---------------------------------------------------------
// GOOGLE DRIVE - ORGANIZAÇÃO DE GRAVAÇÕES DO MEET
// ---------------------------------------------------------
const redmineIssueByIdCache = new Map();
const redmineProjectByIdCache = new Map();
const redmineUserByIdCache = new Map();
const mattermostUserCache = new Map();
const redmineStatusIdByNameCache = new Map();

function normalizeDriveName(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function escapeDriveQueryValue(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function getGoogleDriveClient() {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
    throw new Error('Credenciais do Google Drive incompletas no .env.');
  }

  const oauth2Client = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);
  oauth2Client.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
  return google.drive({ version: 'v3', auth: oauth2Client });
}

function extractIssueIdAndDateFromFilename(filename) {
  const name = String(filename || '').trim();

  // Os arquivos das gravações devem começar com o número da tarefa:
  // Ex.: "#58851 Treinamento cliente.mp4"
  // Isso evita pesquisar números soltos no nome do arquivo e reduz consultas indevidas ao Redmine.
  const issueMatch = name.match(/^#(\d{3,})(?:\b|\s|[-_.])/);
  const issueId = issueMatch ? issueMatch[1] : null;

  const dateMatch =
    name.match(/\b(\d{4})[-_.](\d{2})[-_.](\d{2})\b/) ||
    name.match(/\b(\d{2})[-_.](\d{2})[-_.](\d{4})\b/);

  let fileDate = null;
  if (dateMatch) {
    if (dateMatch[1].length === 4) {
      fileDate = `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`;
    } else {
      fileDate = `${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}`;
    }
  }

  return { issueId, fileDate };
}

function getCustomFieldValue(issue, fieldNames) {
  const names = Array.isArray(fieldNames) ? fieldNames : [fieldNames];
  const normalizedNames = names.map(normalizeDriveName);
  const fields = issue?.custom_fields || [];

  const field = fields.find(f => normalizedNames.includes(normalizeDriveName(f.name)));
  if (!field) return null;

  if (Array.isArray(field.value)) {
    return field.value.filter(Boolean).join(', ');
  }

  return field.value || null;
}

function getIssueDateString(issue) {
  const dateValue = getCustomFieldValue(issue, ['Data']);
  return dateValue || issue?.due_date || null;
}

function getIssueTimeString(issue) {
  const timeValue = getCustomFieldValue(issue, [ALERT_FIELD_NAME, 'Horário', 'Horario', 'Hora']);
  return timeValue ? String(timeValue).trim() : null;
}

function normalizeIssueTimeValue(timeValue) {
  if (!timeValue) return null;

  const normalized = String(timeValue)
    .trim()
    .toLowerCase()
    .replace(/\s/g, '')
    .replace(/[.;]/g, ':')
    .replace('h', ':');

  const match = normalized.match(/^(\d{1,2})(?::?(\d{2}))?(?::?(\d{2}))?$/);
  if (!match) return normalized;

  const hour = String(match[1]).padStart(2, '0');
  const minute = String(match[2] || '00').padStart(2, '0');
  const second = String(match[3] || '00').padStart(2, '0');

  return `${hour}:${minute}:${second}`;
}

function getIssueAppointmentDateTime(issue) {
  const issueDateStr = getIssueDateString(issue);
  const timeValue = getIssueTimeString(issue);

  if (!issueDateStr || !timeValue) {
    return null;
  }

  const datePart = String(issueDateStr).trim().slice(0, 10);
  const normalizedTime = normalizeIssueTimeValue(timeValue);
  const candidate = `${datePart} ${normalizedTime}`;
  const formats = [
    'YYYY-MM-DD HH:mm:ss',
    'YYYY-MM-DD H:mm:ss',
    'YYYY-MM-DD HH:mm',
    'YYYY-MM-DD H:mm',
    'DD/MM/YYYY HH:mm:ss',
    'DD/MM/YYYY H:mm:ss',
    'DD/MM/YYYY HH:mm',
    'DD/MM/YYYY H:mm'
  ];

  const parsed = dayjs.tz(candidate, formats, 'America/Sao_Paulo');
  return parsed.isValid() ? parsed : null;
}

function issueHasAppointmentOnDate(issue, targetDate) {
  const appointmentAt = getIssueAppointmentDateTime(issue);
  return Boolean(appointmentAt && appointmentAt.startOf('day').isSame(targetDate.startOf('day')));
}

async function fetchRedmineIssueById(issueId) {
  const cached = redmineIssueByIdCache.get(String(issueId));
  const now = Date.now();

  if (cached && now - cached.fetchedAt < 30 * 60 * 1000) {
    return cached.issue;
  }

  const response = await axios.get(`${REDMINE_URL}/issues/${issueId}.json`, {
    headers: getRedmineHeaders(),
    params: { include: 'children,attachments,journals,custom_fields' }
  });

  const issue = response.data.issue;
  redmineIssueByIdCache.set(String(issueId), { issue, fetchedAt: now });
  return issue;
}

async function fetchRedmineProjectById(projectId) {
  if (!projectId) return null;

  const cacheKey = String(projectId);
  const cached = redmineProjectByIdCache.get(cacheKey);
  const now = Date.now();

  if (cached && now - cached.fetchedAt < 60 * 60 * 1000) {
    return cached.project;
  }

  const response = await axios.get(`${REDMINE_URL}/projects/${projectId}.json`, {
    headers: getRedmineHeaders(),
    params: { include: 'custom_fields' }
  });

  const project = response.data.project;
  redmineProjectByIdCache.set(cacheKey, { project, fetchedAt: now });
  return project;
}

function extractFirstNumber(value) {
  const text = Array.isArray(value) ? value.filter(Boolean).join(', ') : String(value || '');
  const match = text.match(/\d+/);
  return match ? match[0] : null;
}

async function getProjectPersonalizationNumberFromIssue(issue) {
  const projectId = issue?.project?.id;
  const projectName = issue?.project?.name || 'não informado';

  if (!projectId) {
    console.log(`[DRIVE] Task #${issue?.id || '?'} sem projeto informado no retorno do Redmine.`);
    return null;
  }

  const project = await fetchRedmineProjectById(projectId);
  const fieldValue = getCustomFieldValue(project, [
    PROJECT_PERSONALIZATION_FIELD_NAME,
    PERSONALIZATION_NUMBER_FIELD_NAME,
    'Personalização',
    'Personalizacao',
    'Número Personalização',
    'Numero Personalizacao',
    'Número da Personalização',
    'Numero da Personalizacao'
  ]);

  const personalizationNumber = extractFirstNumber(fieldValue);
  if (!personalizationNumber) {
    console.log(
      `[DRIVE] Projeto "${projectName}" da Task #${issue?.id || '?'} sem campo personalizado de personalização preenchido. ` +
      `Verifique o campo "${PROJECT_PERSONALIZATION_FIELD_NAME}" na configuração do projeto.`
    );
    return null;
  }

  return personalizationNumber;
}

async function findFolderByName(drive, name, parentId = null) {
  if (!name) return null;

  const queryParts = [
    "mimeType = 'application/vnd.google-apps.folder'",
    "trashed = false",
    `name = '${escapeDriveQueryValue(name)}'`
  ];

  if (parentId) {
    queryParts.push(`'${escapeDriveQueryValue(parentId)}' in parents`);
  }

  const response = await drive.files.list({
    q: queryParts.join(' and '),
    fields: 'files(id,name,parents)',
    pageSize: 10,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true
  });

  return (response.data.files || [])[0] || null;
}

async function findFolderContainingText(drive, text, parentId = null) {
  if (!text) return null;

  const queryParts = [
    "mimeType = 'application/vnd.google-apps.folder'",
    "trashed = false",
    `name contains '${escapeDriveQueryValue(text)}'`
  ];

  if (parentId) {
    queryParts.push(`'${escapeDriveQueryValue(parentId)}' in parents`);
  }

  const response = await drive.files.list({
    q: queryParts.join(' and '),
    fields: 'files(id,name,parents)',
    pageSize: 20,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true
  });

  const folders = response.data.files || [];
  const normalizedText = normalizeDriveName(text);
  return folders.find(folder => normalizeDriveName(folder.name).includes(normalizedText)) || folders[0] || null;
}

async function findOrCreateTrainingsFolder(drive, personalizationFolderId) {
  const existing = await findFolderByName(drive, TRAININGS_FOLDER_NAME, personalizationFolderId);
  if (existing) return existing;

  const response = await drive.files.create({
    requestBody: {
      name: TRAININGS_FOLDER_NAME,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [personalizationFolderId]
    },
    fields: 'id,name',
    supportsAllDrives: true
  });

  return response.data;
}

async function moveDriveFileToFolder(drive, file, targetFolderId) {
  const previousParents = (file.parents || []).join(',');

  await drive.files.update({
    fileId: file.id,
    addParents: targetFolderId,
    removeParents: previousParents || undefined,
    fields: 'id,parents',
    supportsAllDrives: true
  });
}


function isVideoDriveFile(file) {
  return String(file?.mimeType || '').startsWith('video/') ||
    Boolean(file?.videoMediaMetadata?.durationMillis);
}

function formatVideoDuration(durationMillis) {
  const totalSeconds = Math.max(0, Math.round(Number(durationMillis || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, '0')}min ${String(seconds).padStart(2, '0')}s`;
  }

  return `${minutes}min ${String(seconds).padStart(2, '0')}s`;
}

async function getDriveVideoDurationMillis(drive, file) {
  if (file?.videoMediaMetadata?.durationMillis) {
    return Number(file.videoMediaMetadata.durationMillis);
  }

  const response = await drive.files.get({
    fileId: file.id,
    fields: 'id,name,mimeType,videoMediaMetadata(durationMillis)',
    supportsAllDrives: true
  });

  return Number(response.data?.videoMediaMetadata?.durationMillis || 0);
}

async function addRedmineIssueJournal(issueId, notes) {
  if (!notes) return;

  await axios.put(`${REDMINE_URL}/issues/${issueId}.json`, {
    issue: { notes }
  }, {
    headers: getRedmineHeaders()
  });
}

async function addVideoDurationJournalAfterMove(drive, file, issueId, destinationDescription) {
  if (!isVideoDriveFile(file)) {
    return;
  }

  const durationMillis = await getDriveVideoDurationMillis(drive, file);
  if (!durationMillis) {
    console.log(`[DRIVE] Arquivo "${file.name}" é vídeo, mas a duração não veio no metadata do Drive.`);
    return;
  }

  const durationText = formatVideoDuration(durationMillis);
  const notes =
    `Gravação do Meet movida para ${destinationDescription}.\n` +
    `Tempo total do vídeo: ${durationText}.`;

  await addRedmineIssueJournal(issueId, notes);
  console.log(`[REDMINE] Journal gravado na Task #${issueId} com duração do vídeo: ${durationText}.`);
}

async function processMeetRecordings() {
  if (!GOOGLE_DRIVE_RECORDINGS_FOLDER_ID || !GOOGLE_DRIVE_CLIENTES_FOLDER_ID) {
    console.log('[DRIVE] Pastas do Drive não configuradas. Rotina ignorada.');
    return;
  }

  const drive = getGoogleDriveClient();

  const response = await drive.files.list({
    q: `'${escapeDriveQueryValue(GOOGLE_DRIVE_RECORDINGS_FOLDER_ID)}' in parents and trashed = false`,
    fields: 'files(id,name,mimeType,parents,createdTime,videoMediaMetadata(durationMillis))',
    orderBy: 'createdTime desc',
    pageSize: Math.max(1, Math.min(Number(DRIVE_MOVER_LIMIT) || 10, 50)),
    supportsAllDrives: true,
    includeItemsFromAllDrives: true
  });

  const files = response.data.files || [];
  if (!files.length) {
    console.log('[DRIVE] Nenhuma gravação nova do Meet encontrada.');
    return;
  }

  for (const file of files) {
    try {
      if (file.mimeType === 'application/vnd.google-apps.folder') {
        continue;
      }

      const { issueId, fileDate } = extractIssueIdAndDateFromFilename(file.name);
      if (!issueId) {
        console.log(`[DRIVE] Arquivo ignorado porque não começa com #ID da tarefa no Redmine: ${file.name}`);
        continue;
      }

      const issue = await fetchRedmineIssueById(issueId);
      const projectName = issue?.project?.name || '';

      const personalizationNumber = await getProjectPersonalizationNumberFromIssue(issue);

      if (!personalizationNumber) {
        console.log(`[DRIVE] Task #${issueId} sem número de personalização no campo personalizado do projeto.`);
        continue;
      }

      const personalizationFolder = await findFolderContainingText(
        drive,
        String(personalizationNumber),
        GOOGLE_DRIVE_CLIENTES_FOLDER_ID
      );

      if (!personalizationFolder) {
        console.log(`[DRIVE] Pasta da personalização ${personalizationNumber} não encontrada para Task #${issueId}. Projeto: ${projectName}`);
        continue;
      }

      const trainingsFolder = await findOrCreateTrainingsFolder(drive, personalizationFolder.id);
      await moveDriveFileToFolder(drive, file, trainingsFolder.id);
      const destinationDescription = `${personalizationFolder.name}/${trainingsFolder.name}`;
      await addVideoDurationJournalAfterMove(drive, file, issueId, destinationDescription);

      console.log(
        `[DRIVE] Arquivo "${file.name}" movido para ${personalizationFolder.name}/${trainingsFolder.name}. ` +
        `Task #${issueId}${fileDate ? `, data ${fileDate}` : ''}, projeto: ${projectName || 'não informado'}.`
      );
    } catch (err) {
      console.error(`[DRIVE] Falha ao processar "${file.name}":`, err.message);
    }
  }
}

// ---------------------------------------------------------
// OUTRAS ROTINAS EM PARALELO (SUMMARIES)
// ---------------------------------------------------------
function getNextBusinessDay(baseDate = dayjs().tz('America/Sao_Paulo')) {
  let next = baseDate.add(1, 'day').startOf('day');

  while (next.day() === 0 || next.day() === 6) {
    next = next.add(1, 'day');
  }

  return next;
}

function shouldRunDailySummaryNow() {
  if (String(DAILY_SUMMARY_ENABLED).toLowerCase() !== 'true') {
    return false;
  }

  const agora = dayjs().tz('America/Sao_Paulo');

  // O resumo operacional deve rodar em dias úteis. Na sexta, o alvo será segunda.
  if (agora.day() === 0 || agora.day() === 6) {
    return false;
  }

  return agora.hour() === Number(DAILY_SUMMARY_HOUR) &&
    agora.minute() === Number(DAILY_SUMMARY_MINUTE);
}

function formatDateBr(date) {
  return date.tz('America/Sao_Paulo').format('DD/MM/YYYY');
}

function formatIssueTime(issue) {
  const appointmentAt = getIssueAppointmentDateTime(issue);
  if (appointmentAt) {
    return appointmentAt.format('HH:mm');
  }

  const timeValue = getIssueTimeString(issue);
  return timeValue ? String(timeValue).trim() : 'sem horário';
}

function formatIssueEstimatedHours(issue) {
  if (issue.estimated_hours === null || issue.estimated_hours === undefined || issue.estimated_hours === '') {
    return null;
  }

  const value = Number(issue.estimated_hours);
  if (!Number.isFinite(value)) {
    return String(issue.estimated_hours);
  }

  return `${String(value).replace('.', ',')}h`;
}

function isIssueOnDate(issue, targetDate) {
  return issueHasAppointmentOnDate(issue, targetDate);
}

async function fetchRedmineStatusIdByName(statusName) {
  const normalized = normalizeDriveName(statusName);
  if (redmineStatusIdByNameCache.has(normalized)) {
    return redmineStatusIdByNameCache.get(normalized);
  }

  const response = await axios.get(`${REDMINE_URL}/issue_statuses.json`, {
    headers: getRedmineHeaders()
  });

  const statuses = response.data.issue_statuses || [];
  for (const status of statuses) {
    redmineStatusIdByNameCache.set(normalizeDriveName(status.name), status.id);
  }

  return redmineStatusIdByNameCache.get(normalized) || null;
}

async function fetchIssuesForDailySummary(targetDate) {
  const statusId = await fetchRedmineStatusIdByName(MEET_STATUS_NAME);
  const issues = [];
  const limit = 100;
  let offset = 0;
  let totalCount = 0;

  do {
    const params = {
      limit,
      offset,
      sort: 'due_date:asc,id:asc',
      status_id: statusId || '*'
    };

    const response = await axios.get(`${REDMINE_URL}/issues.json`, {
      headers: getRedmineHeaders(),
      params
    });

    const pageIssues = response.data.issues || [];
    totalCount = Number(response.data.total_count || pageIssues.length || 0);

    for (const issue of pageIssues) {
      const statusName = issue.status ? issue.status.name : '';
      if (statusName === MEET_STATUS_NAME && isIssueOnDate(issue, targetDate)) {
        issues.push(issue);
      }
    }

    offset += limit;
  } while (offset < totalCount);

  return issues;
}

async function fetchRedmineUserById(userId) {
  if (!userId) return null;

  const cacheKey = String(userId);
  const cached = redmineUserByIdCache.get(cacheKey);
  const now = Date.now();

  if (cached && now - cached.fetchedAt < 60 * 60 * 1000) {
    return cached.user;
  }

  const response = await axios.get(`${REDMINE_URL}/users/${userId}.json`, {
    headers: getRedmineHeaders()
  });

  const user = response.data.user || null;
  redmineUserByIdCache.set(cacheKey, { user, fetchedAt: now });
  return user;
}

async function findMattermostUserForRedmineUser(redmineUser) {
  if (!redmineUser) return null;

  const candidates = [
    redmineUser.login,
    redmineUser.mail,
    [redmineUser.firstname, redmineUser.lastname].filter(Boolean).join(' '),
    redmineUser.lastname,
    redmineUser.firstname
  ].filter(Boolean);

  const cacheKey = candidates.join('|').toLowerCase();
  if (mattermostUserCache.has(cacheKey)) {
    return mattermostUserCache.get(cacheKey);
  }

  for (const candidate of candidates) {
    try {
      const byUsername = await axios.get(
        `${MATTERMOST_URL}/api/v4/users/username/${encodeURIComponent(candidate)}`,
        { headers: { Authorization: `Bearer ${MATTERMOST_TOKEN}` } }
      );

      if (byUsername.data?.id) {
        mattermostUserCache.set(cacheKey, byUsername.data);
        return byUsername.data;
      }
    } catch (err) {
      if (err.response?.status !== 404) {
        console.log(`[MATTERMOST] Falha ao buscar usuário por username "${candidate}": ${err.message}`);
      }
    }

    try {
      const search = await axios.post(
        `${MATTERMOST_URL}/api/v4/users/search`,
        { term: candidate, limit: 10 },
        { headers: { Authorization: `Bearer ${MATTERMOST_TOKEN}` } }
      );

      const users = search.data || [];
      const normalizedCandidate = normalizeDriveName(candidate);
      const found = users.find(user =>
        normalizeDriveName(user.username) === normalizedCandidate ||
        normalizeDriveName(user.email) === normalizedCandidate ||
        normalizeDriveName(`${user.first_name || ''} ${user.last_name || ''}`.trim()) === normalizedCandidate
      ) || users[0];

      if (found?.id) {
        mattermostUserCache.set(cacheKey, found);
        return found;
      }
    } catch (err) {
      console.log(`[MATTERMOST] Falha ao pesquisar usuário "${candidate}": ${err.message}`);
    }
  }

  mattermostUserCache.set(cacheKey, null);
  return null;
}

async function sendMattermostDirectMessage(userId, message) {
  const channelResponse = await axios.post(
    `${MATTERMOST_URL}/api/v4/channels/direct`,
    [userId],
    { headers: { Authorization: `Bearer ${MATTERMOST_TOKEN}` } }
  );

  await axios.post(
    `${MATTERMOST_URL}/api/v4/posts`,
    {
      channel_id: channelResponse.data.id,
      message
    },
    { headers: { Authorization: `Bearer ${MATTERMOST_TOKEN}` } }
  );
}

function buildDailySummaryMessage(assignedIssues, targetDate) {
  const sorted = [...assignedIssues].sort((a, b) => {
    const appointmentA = getIssueAppointmentDateTime(a);
    const appointmentB = getIssueAppointmentDateTime(b);
    const timeA = appointmentA ? appointmentA.valueOf() : Number.MAX_SAFE_INTEGER;
    const timeB = appointmentB ? appointmentB.valueOf() : Number.MAX_SAFE_INTEGER;
    return timeA - timeB || Number(a.id) - Number(b.id);
  });

  const lines = [
    `### Resumo dos compromissos do próximo dia útil - ${formatDateBr(targetDate)}`,
    '',
    `Você possui ${sorted.length} compromisso(s) com status **${MEET_STATUS_NAME}** para o próximo dia útil.`,
    ''
  ];

  for (const issue of sorted) {
    const horario = formatIssueTime(issue);
    const estimativa = formatIssueEstimatedHours(issue);
    const projeto = issue.project?.name ? ` - ${issue.project.name}` : '';
    const estimatedText = estimativa ? ` | Estimativa: ${estimativa}` : '';
    const issueUrl = `${String(REDMINE_URL).replace(/\/$/, '')}/issues/${issue.id}`;

    lines.push(`- **${horario}** | #${issue.id}${projeto} | ${issue.subject || 'Sem assunto'}${estimatedText}`);
    lines.push(`  ${issueUrl}`);
  }

  return lines.join('\n');
}

async function processDailySummary() {
  if (!shouldRunDailySummaryNow()) {
    return;
  }

  const agora = dayjs().tz('America/Sao_Paulo');
  const targetDate = getNextBusinessDay(agora);
  const runKey = `mattermost:daily-summary:${agora.format('YYYY-MM-DD')}:${Number(DAILY_SUMMARY_HOUR)}:${Number(DAILY_SUMMARY_MINUTE)}`;

  const alreadyRun = await redis.get(runKey);
  if (alreadyRun) {
    return;
  }

  if (!MATTERMOST_URL || !MATTERMOST_TOKEN) {
    console.log('[SUMMARY] Mattermost não configurado. Resumo diário ignorado.');
    await redis.set(runKey, 'mattermost-not-configured', 'EX', 2 * 60 * 60);
    return;
  }

  const issues = await fetchIssuesForDailySummary(targetDate);
  if (!issues.length) {
    console.log(`[SUMMARY] Nenhum compromisso em ${MEET_STATUS_NAME} para ${formatDateBr(targetDate)}.`);
    await redis.set(runKey, 'no-issues', 'EX', 2 * 60 * 60);
    return;
  }

  const issuesByAssignedUserId = new Map();

  for (const issue of issues) {
    const assignedUserId = issue.assigned_to?.id;
    if (!assignedUserId) {
      console.log(`[SUMMARY] Task #${issue.id} sem responsável. Não foi possível enviar DM.`);
      continue;
    }

    if (!issuesByAssignedUserId.has(assignedUserId)) {
      issuesByAssignedUserId.set(assignedUserId, []);
    }
    issuesByAssignedUserId.get(assignedUserId).push(issue);
  }

  let sentCount = 0;

  for (const [redmineUserId, assignedIssues] of issuesByAssignedUserId.entries()) {
    try {
      const redmineUser = await fetchRedmineUserById(redmineUserId);
      const mattermostUser = await findMattermostUserForRedmineUser(redmineUser);

      if (!mattermostUser?.id) {
        console.log(`[SUMMARY] Usuário Mattermost não encontrado para Redmine user #${redmineUserId}.`);
        continue;
      }

      const message = buildDailySummaryMessage(assignedIssues, targetDate);
      await sendMattermostDirectMessage(mattermostUser.id, message);
      sentCount += 1;

      console.log(
        `[SUMMARY] Resumo do próximo dia útil enviado para ${mattermostUser.username || mattermostUser.id} ` +
        `com ${assignedIssues.length} compromisso(s).`
      );
    } catch (err) {
      console.error(`[SUMMARY] Falha ao enviar resumo para Redmine user #${redmineUserId}:`, err.message);
    }
  }

  await redis.set(runKey, `sent:${sentCount}`, 'EX', 2 * 60 * 60);
}


function parseClientSummaryTime() {
  const raw = String(CLIENT_SUMMARY_TIME || '08:30').trim();
  const match = raw.match(/^(\d{1,2}):(\d{2})$/);

  if (!match) {
    return { hour: 8, minute: 30 };
  }

  return {
    hour: Number(match[1]),
    minute: Number(match[2])
  };
}

function shouldRunClientMorningSummaryNow() {
  const agora = dayjs().tz('America/Sao_Paulo');

  // A confirmação do cliente deve rodar em dia útil, sempre olhando o próximo dia útil.
  if (agora.day() === 0 || agora.day() === 6) {
    return false;
  }

  const { hour, minute } = parseClientSummaryTime();
  return agora.hour() === hour && agora.minute() === minute;
}

function issueHasEstimatedHours(issue) {
  return issue.estimated_hours !== null &&
    issue.estimated_hours !== undefined &&
    issue.estimated_hours !== '' &&
    Number(issue.estimated_hours) > 0;
}

function getIssueWhatsAppGroupJid(issue) {
  const groupValue = getCustomFieldValue(issue, [
    WHATSAPP_GROUP_FIELD_NAME,
    'ID Grupo WhatsApp',
    'Grupo WhatsApp',
    'Whatsapp',
    'WhatsApp'
  ]);

  return normalizeWhatsAppGroupJid(groupValue);
}

function buildClientMorningSummaryMessage(issues, targetDate) {
  const sorted = [...issues].sort((a, b) => {
    const appointmentA = getIssueAppointmentDateTime(a);
    const appointmentB = getIssueAppointmentDateTime(b);
    const timeA = appointmentA ? appointmentA.valueOf() : Number.MAX_SAFE_INTEGER;
    const timeB = appointmentB ? appointmentB.valueOf() : Number.MAX_SAFE_INTEGER;
    return timeA - timeB || Number(a.id) - Number(b.id);
  });

  const lines = [
    `Bom dia! Passando para confirmar o(s) compromisso(s) agendado(s) para ${formatDateBr(targetDate)}:`,
    ''
  ];

  for (const issue of sorted) {
    const horario = formatIssueTime(issue);
    const estimativa = formatIssueEstimatedHours(issue);
    const projeto = issue.project?.name ? ` - ${issue.project.name}` : '';
    const issueUrl = `${String(REDMINE_URL).replace(/\/$/, '')}/issues/${issue.id}`;

    lines.push(`• ${horario} - #${issue.id}${projeto} - ${issue.subject || 'Compromisso'}`);
    if (estimativa) {
      lines.push(`  Duração prevista: ${estimativa}`);
    }
    lines.push(`  ${issueUrl}`);
  }

  lines.push('');
  lines.push('Por favor, confirme o recebimento e a disponibilidade para o horário agendado.');

  return lines.join('\n');
}

async function processClientMorningSummary() {
  if (!shouldRunClientMorningSummaryNow()) {
    return;
  }

  const agora = dayjs().tz('America/Sao_Paulo');
  const { hour, minute } = parseClientSummaryTime();
  const targetDate = getNextBusinessDay(agora);
  const runKey = `whatsapp:client-summary:${agora.format('YYYY-MM-DD')}:${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;

  const alreadyRun = await redis.get(runKey);
  if (alreadyRun) {
    return;
  }

  if (!sock?.user) {
    console.log('[WHATSAPP SUMMARY] WhatsApp não conectado. Confirmação das 8h30 ignorada neste ciclo.');
    return;
  }

  const issues = await fetchIssuesForDailySummary(targetDate);
  const issuesByGroup = new Map();

  for (const issue of issues) {
    const appointmentAt = getIssueAppointmentDateTime(issue);
    const groupJid = getIssueWhatsAppGroupJid(issue);

    // Confirmação só para compromissos com data, horário, tempo estimado e grupo WhatsApp.
    if (!appointmentAt || !issueHasEstimatedHours(issue) || !groupJid) {
      continue;
    }

    if (!issuesByGroup.has(groupJid)) {
      issuesByGroup.set(groupJid, []);
    }
    issuesByGroup.get(groupJid).push(issue);
  }

  let sentCount = 0;

  for (const [groupJid, groupIssues] of issuesByGroup.entries()) {
    const groupKey = `whatsapp:client-summary:group:${groupJid}:${targetDate.format('YYYY-MM-DD')}`;
    const alreadySentToGroup = await redis.get(groupKey);
    if (alreadySentToGroup) {
      continue;
    }

    try {
      const message = buildClientMorningSummaryMessage(groupIssues, targetDate);
      const sent = await sendWhatsAppMessage(groupJid, message);

      if (sent) {
        sentCount += 1;
        await redis.set(groupKey, `sent:${groupIssues.length}`, 'EX', Number(REDIS_TTL_DAYS) * 24 * 60 * 60);
        console.log(`[WHATSAPP SUMMARY] Confirmação enviada para ${groupJid} com ${groupIssues.length} compromisso(s).`);
      }
    } catch (err) {
      console.error(`[WHATSAPP SUMMARY] Falha ao enviar confirmação para ${groupJid}:`, err.message);
    }
  }

  await redis.set(runKey, `sent:${sentCount}`, 'EX', 2 * 60 * 60);
}


startWhatsAppConnection().catch(err => console.error('[WHATSAPP] Erro na inicialização:', err.message));

// ---------------------------------------------------------
// INICIALIZADORES DOS LOOPS RECURSIVOS (TIMEOUT DINÂMICO)
// ---------------------------------------------------------
if (POLLING_ENABLED !== 'true') {
  console.log('[POLLING] Recursos de polling globais desativados via ENV.');
} else {
  console.log('[POLLING] Inicializando loop único com cache e janelas comerciais.');

  async function loopRedmineUnificado() {
    try {
      const issues = await fetchRedmineIssuesOptimized();
      await pollingRedmineIssues(issues);
      await pollingAppointmentAlerts(issues);
    } catch (err) {
      console.error('[POLLING ERRO]:', err.message);
    } finally {
      const proximoIntervalo = getDynamicPollingIntervalInSeconds();
      console.log(`[POLLING] Próxima leitura do Redmine em ${proximoIntervalo}s.`);
      setTimeout(loopRedmineUnificado, proximoIntervalo * 1000);
    }
  }

  loopRedmineUnificado();
}

// Manutenção dos processos secundários estruturados de hora em hora/minuto fixo.
// Estas rotinas permanecem separadas porque podem ter regras de disparo próprias.
setInterval(() => {
  processDailySummary().catch(err => console.error('[SUMMARY ERR]:', err.message));
}, 60 * 1000);

setInterval(() => {
  processClientMorningSummary().catch(err => console.error('[WHATSAPP SUMMARY ERR]:', err.message));
}, 60 * 1000);

setInterval(() => {
  processMeetRecordings().catch(err => console.error('[DRIVE ERR]:', err.message));
}, Math.max(60, Number(DRIVE_MOVER_INTERVAL_SECONDS) || 300) * 1000);

// Inicialização do servidor Express
app.listen(PORT, () => {
  console.log(`[SERVER] Aplicação rodando com sucesso na porta ${PORT}`);
});
