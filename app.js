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

// Cache em memória para evitar leituras duplicadas do Redmine no mesmo ciclo.
// Importante: isso reduz consumo do Redmine sem aumentar leitura/gravação no Redis.
let redmineIssuesCache = [];
let redmineIssuesCacheFetchedAt = null;
let lastSuccessfulRedmineFetchAt = null;

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
async function pollingAppointmentAlerts(issues) {
  console.log('[ALERTAS] Processando proximidade de horários...');

  const hoje = dayjs().tz('America/Sao_Paulo').startOf('day');

  for (const issue of issues) {
    const statusName = issue.status ? issue.status.name : '';
    if (statusName !== MEET_STATUS_NAME) {
      continue;
    }

    const customFields = issue.custom_fields || [];
    const dateField = customFields.find(f => f.name === 'Data');
    const timeField = customFields.find(f => f.name === ALERT_FIELD_NAME);

    const issueDateStr = dateField ? dateField.value : issue.due_date;

    // Ignora sem data/horário e tudo que já passou.
    if (!issueDateStr || !timeField || !timeField.value) {
      continue;
    }

    const issueDate = dayjs(issueDateStr).tz('America/Sao_Paulo').startOf('day');
    if (issueDate.isBefore(hoje)) {
      continue;
    }

    const alertKey = `redmine:appointment:${issue.id}:alerted`;
    const alreadyAlerted = await redis.get(alertKey);

    if (!alreadyAlerted) {
      // Lógica matemática de aproximação de horário (ex: faltando 10 min para o compromisso)
      // Se estiver dentro da janela de disparo, executa sock.sendMessage() ou Mattermost e:
      // await redis.set(alertKey, 'true', 'EX', 86400);
    }
  }
}

// ---------------------------------------------------------
// GOOGLE DRIVE - ORGANIZAÇÃO DE GRAVAÇÕES DO MEET
// ---------------------------------------------------------
const redmineIssueByIdCache = new Map();
const redmineProjectByIdCache = new Map();

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
async function processDailySummary() { /* Lógica existente */ }
async function processClientMorningSummary() { /* Lógica existente */ }

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
