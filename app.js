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
  REDMINE_CACHE_TTL_SECONDS = 45
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
// OUTRAS ROTINAS EM PARALELO (SUMMARIES E DRIVE MOVER)
// ---------------------------------------------------------
async function processDailySummary() { /* Lógica existente */ }
async function processClientMorningSummary() { /* Lógica existente */ }
async function processMeetRecordings() { /* Lógica existente do Google Drive */ }

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
}, 60 * 1000);

// Inicialização do servidor Express
app.listen(PORT, () => {
  console.log(`[SERVER] Aplicação rodando com sucesso na porta ${PORT}`);
});
