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
  WHATSAPP_GROUP_FIELD_NAME = 'ID Grupo WhatsApp',
  ALERT_WINDOW_SECONDS = 180,
  ALERT_FIELD_NAME = 'Horário',
  ALERT_POLLING_INTERVAL_SECONDS = 60,
  DAILY_SUMMARY_ENABLED = 'true',
  DAILY_SUMMARY_HOUR = 17,
  DAILY_SUMMARY_MINUTE = 45,
  CLIENT_SUMMARY_TIME = '08:30',
  MEET_STATUS_NAME = 'Aguardando Data',
  MATTERMOST_REDMINE_LOGIN_FIELD_NAME = 'Login Mattermost'
} = process.env;

const app = express();

axios.defaults.timeout = Number(process.env.HTTP_TIMEOUT_MS || 30000);

// Retry simples para falhas transitórias comuns no Render/Redmine/Mattermost.
// ECONNRESET normalmente significa que o servidor remoto fechou a conexão antes da resposta.
function isTransientNetworkError(error) {
  const code = error && error.code;
  const status = error && error.response && error.response.status;

  return (
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNABORTED' ||
    code === 'EAI_AGAIN' ||
    code === 'ENOTFOUND' ||
    code === 'ECONNREFUSED' ||
    status === 408 ||
    status === 429 ||
    (status >= 500 && status <= 599)
  );
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function withHttpRetry(operation, label, maxAttempts = Number(process.env.HTTP_RETRY_ATTEMPTS || 3)) {
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      if (!isTransientNetworkError(error) || attempt >= maxAttempts) {
        throw error;
      }

      const waitMs = Math.min(1000 * attempt, 5000);
      console.warn(`[HTTP RETRY] ${label} falhou (${error.code || (error.response && error.response.status) || error.message}). Tentativa ${attempt + 1}/${maxAttempts} em ${waitMs}ms.`);
      await sleep(waitMs);
    }
  }

  throw lastError;
}


app.use(express.json());

const redis = new Redis(REDIS_URL);
let sock = null; // Instância do WhatsApp Baileys

const TZ = 'America/Sao_Paulo';

function cleanValue(value) {
  return String(value || '').trim();
}

function getCustomField(issue, fieldName) {
  return (issue.custom_fields || []).find(f => f.name === fieldName);
}

function getIssueDate(issue) {
  const dateField = getCustomField(issue, 'Data');
  return cleanValue(dateField && dateField.value ? dateField.value : issue.due_date);
}

function getIssueTime(issue) {
  const timeField = getCustomField(issue, ALERT_FIELD_NAME);
  return cleanValue(timeField && timeField.value);
}

function parseAppointmentDateTime(dateStr, timeStr) {
  if (!dateStr || !timeStr) return null;

  const normalizedTime = timeStr.replace('h', ':').replace(/\s/g, '');
  const parsed = dayjs.tz(
    `${dateStr} ${normalizedTime}`,
    [
      'YYYY-MM-DD HH:mm',
      'YYYY-MM-DD H:mm',
      'YYYY-MM-DD HH:mm:ss',
      'DD/MM/YYYY HH:mm',
      'DD/MM/YYYY H:mm'
    ],
    TZ
  );

  return parsed.isValid() ? parsed : null;
}

function getNextBusinessDay(baseDate = dayjs().tz(TZ)) {
  let next = baseDate.add(1, 'day').startOf('day');
  while (next.day() === 0 || next.day() === 6) {
    next = next.add(1, 'day');
  }
  return next;
}

function shouldRunAtConfiguredMinute(hour, minute) {
  const now = dayjs().tz(TZ);
  return now.hour() === Number(hour) && now.minute() === Number(minute);
}

function parseHourMinute(value, fallback = '08:30') {
  const raw = cleanValue(value || fallback);
  const match = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return { hour: 8, minute: 30 };

  return {
    hour: Number(match[1]),
    minute: Number(match[2])
  };
}

function shouldRunAtConfiguredTime(value, fallback = '08:30') {
  const { hour, minute } = parseHourMinute(value, fallback);
  return shouldRunAtConfiguredMinute(hour, minute);
}

async function getMattermostUserIdFromIssue(issue) {
  const mattermostLoginField = getCustomField(issue, MATTERMOST_REDMINE_LOGIN_FIELD_NAME);
  const login = cleanValue(mattermostLoginField && mattermostLoginField.value);

  if (login) {
    const response = await withHttpRetry(
    () => axios.get(`${MATTERMOST_URL}/api/v4/users/username/${encodeURIComponent(login)}`, {
      headers: { Authorization: `Bearer ${MATTERMOST_TOKEN}` }
    }),
    `Mattermost usuário ${login}`
  );
    return response.data.id;
  }

  // Fallback: tenta localizar pelo nome do atribuído no Redmine.
  // Ideal: criar um campo personalizado "Login Mattermost" no Redmine.
  const assignedName = issue.assigned_to && issue.assigned_to.name ? issue.assigned_to.name : '';
  if (!assignedName) return null;

  const search = await withHttpRetry(
    () => axios.post(
      `${MATTERMOST_URL}/api/v4/users/search`,
      { term: assignedName },
      { headers: { Authorization: `Bearer ${MATTERMOST_TOKEN}` } }
    ),
    `Mattermost busca usuário ${assignedName}`
  );

  return search.data && search.data[0] ? search.data[0].id : null;
}

async function createMattermostDirectChannel(userId) {
  const me = await withHttpRetry(
    () => axios.get(`${MATTERMOST_URL}/api/v4/users/me`, {
      headers: { Authorization: `Bearer ${MATTERMOST_TOKEN}` }
    }),
    'Mattermost users/me'
  );

  const response = await withHttpRetry(
    () => axios.post(
      `${MATTERMOST_URL}/api/v4/channels/direct`,
      [me.data.id, userId],
      { headers: { Authorization: `Bearer ${MATTERMOST_TOKEN}` } }
    ),
    `Mattermost canal direto ${userId}`
  );

  return response.data;
}

async function sendMattermostDirectMessage(userId, message) {
  if (!MATTERMOST_URL || !MATTERMOST_TOKEN || !userId) return false;

  const channel = await createMattermostDirectChannel(userId);

  await withHttpRetry(
    () => axios.post(
      `${MATTERMOST_URL}/api/v4/posts`,
      { channel_id: channel.id, message },
      { headers: { Authorization: `Bearer ${MATTERMOST_TOKEN}` } }
    ),
    `Mattermost post canal ${channel.id}`
  );

  return true;
}

async function fetchRedmineIssues(params = {}) {
  const allIssues = [];
  const limit = Number(params.limit || 100);
  let offset = Number(params.offset || 0);
  let totalCount = null;

  do {
    const response = await withHttpRetry(
      () => axios.get(`${REDMINE_URL}/issues.json`, {
        headers: { 'X-Redmine-API-Key': REDMINE_API_KEY },
        params: {
          status_id: '*',
          sort: 'due_date:asc,updated_on:desc',
          ...params,
          limit,
          offset
        }
      }),
      `Redmine issues offset ${offset}`
    );

    const data = response.data || {};
    const issues = data.issues || [];
    allIssues.push(...issues);

    totalCount = Number(data.total_count || allIssues.length);
    offset += limit;

    if (issues.length === 0) break;
  } while (allIssues.length < totalCount);

  return allIssues;
}

async function fetchAwaitingDateIssues(params = {}) {
  return fetchRedmineIssues(params);
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

  // 1. Finais de Semana (Sábado ou Domingo) -> 1 hora
  if (diaDaSemana === 0 || diaDaSemana === 6) {
    return 3600;
  }

  // 2. Segunda a Sexta: Horário de Almoço (Das 12h15 às 13h15) -> 5 minutos
  const inicioAlmoco = 12 * 60 + 15; // 12:15 em min
  const fimAlmoco = 13 * 60 + 15;    // 13:15 em min
  if (tempoEmMinutos >= inicioAlmoco && tempoEmMinutos < fimAlmoco) {
    return 300; // 5 minutos
  }

  // 3. Segunda a Sexta: Fora do Expediente Comercial (Das 18h15 até às 07h15) -> 1 hora
  const inicioNoite = 18 * 60 + 15; // 18:15 em min
  const fimManha = 7 * 60 + 15;     // 07:15 em min
  if (tempoEmMinutos >= inicioNoite || tempoEmMinutos < fimManha) {
    return 3600; // 1 hora
  }

  // 4. Horário de Expediente Normal (Segunda a Sexta) -> Tempo padrão configurado
  return Number(POLLING_INTERVAL_SECONDS) || 60;
}

// ---------------------------------------------------------
// POLLING DO REDMINE (TASKS E GESTÃO DE STATUS)
// ---------------------------------------------------------
async function pollingRedmineIssues() {
  console.log('[POLLING] Iniciando checagem de rotina no Redmine...');
  
  // Exemplo de chamada ao Redmine buscando atualizações de status relevantes
  const response = await axios.get(`${REDMINE_URL}/issues.json`, {
    headers: { 'X-Redmine-API-Key': REDMINE_API_KEY },
    params: { limit: POLLING_LIMIT, sort: 'updated_on:desc' }
  });

  const issues = response.data.issues || [];
  const hoje = dayjs().tz('America/Sao_Paulo').startOf('day');

  for (const issue of issues) {
    const statusName = issue.status ? issue.status.name : '';
    
    // Identificar campos customizados de data ou usar a data de vencimento nativa
    const customFields = issue.custom_fields || [];
    const dateField = customFields.find(f => f.name === 'Data' || f.name === ALERT_FIELD_NAME);
    const issueDateStr = dateField ? dateField.value : issue.due_date;

    // -------------------------------------------------------------------------
    // TRAVA DE SEGURANÇA REDIS: FILTRAR TAREFAS SEM DATA OU DATAS PASSADAS
    // -------------------------------------------------------------------------
    if (!issueDateStr) {
      // Se a tarefa está em "Aguardando Data" ou qualquer outro status mas não tem data definida,
      // ignora sumariamente para não inflar operações de consulta/gravação no Redis.
      continue;
    }

    const issueDate = dayjs(issueDateStr).tz('America/Sao_Paulo').startOf('day');
    if (issueDate.isBefore(hoje)) {
      // Se a data do agendamento ficou no passado, não há motivo para avaliar ou guardar chaves
      continue;
    }
    // -------------------------------------------------------------------------

    // Fluxo normal de validação no Redis e Disparos
    const redisKey = `redmine:issue:${issue.id}:notified`;
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
async function sendMattermostAppointmentAlert(issue, appointmentAt, minutesBefore) {
  const userId = await getMattermostUserIdFromIssue(issue);

  if (!userId) {
    console.warn(`[ALERTAS] Sem usuário Mattermost para a tarefa #${issue.id}.`);
    return false;
  }

  const url = `${REDMINE_URL}/issues/${issue.id}`;
  const estimated = issue.estimated_hours ? `\nTempo estimado: ${issue.estimated_hours}h` : '';

  const message =
    `⏰ **Lembrete de compromisso**\n\n` +
    `A tarefa **#${issue.id} - ${issue.subject}** começa em **${minutesBefore} minuto(s)**.\n\n` +
    `Data/hora: **${appointmentAt.format('DD/MM/YYYY HH:mm')}**${estimated}\n` +
    `${url}`;

  return sendMattermostDirectMessage(userId, message);
}

async function sendWhatsappAppointmentAlert(issue, appointmentAt, minutesBefore) {
  if (!sock) {
    console.warn(`[ALERTAS] WhatsApp não inicializado. Tarefa #${issue.id} não enviada.`);
    return false;
  }

  const groupField = getCustomField(issue, WHATSAPP_GROUP_FIELD_NAME);
  const groupId = cleanValue(groupField && groupField.value);

  if (!groupId) {
    console.warn(`[ALERTAS] Sem campo "${WHATSAPP_GROUP_FIELD_NAME}" para a tarefa #${issue.id}.`);
    return false;
  }

  const url = `${REDMINE_URL}/issues/${issue.id}`;
  const estimated = issue.estimated_hours ? `\nTempo estimado: ${issue.estimated_hours}h` : '';

  const message =
    `⏰ Lembrete de compromisso\n\n` +
    `A tarefa #${issue.id} - ${issue.subject} começa em ${minutesBefore} minuto(s).\n\n` +
    `Data/hora: ${appointmentAt.format('DD/MM/YYYY HH:mm')}${estimated}\n` +
    `${url}`;

  await sock.sendMessage(groupId, { text: message });
  return true;
}

async function trySendTimedAlert({ issue, appointmentAt, channel, minutesBefore, sendFn }) {
  const now = dayjs().tz(TZ);
  const triggerAt = appointmentAt.subtract(Number(minutesBefore), 'minute');
  const diffSeconds = now.diff(triggerAt, 'second');

  // Só dispara a partir do momento-alvo e dentro da janela configurada.
  // Isso evita envio antecipado e ainda tolera atraso do polling.
  if (diffSeconds < 0 || diffSeconds > Number(ALERT_WINDOW_SECONDS)) return false;

  const alertKey = `redmine:appointment:${issue.id}:${channel}:${minutesBefore}min`;

  if (await redis.get(alertKey)) return false;

  let sent = false;
  try {
    sent = await sendFn(issue, appointmentAt, minutesBefore);
  } catch (error) {
    console.error(`[ALERTAS] Erro ao enviar ${channel} ${minutesBefore}min da tarefa #${issue.id}: ${error.code || error.message}`);
    return false;
  }

  if (!sent) return false;

  await redis.set(alertKey, 'true', 'EX', Number(REDIS_TTL_DAYS) * 24 * 60 * 60);
  console.log(`[ALERTAS] ${channel} ${minutesBefore}min enviado para a tarefa #${issue.id}.`);

  return true;
}

// ---------------------------------------------------------
// MONITORAMENTO DE ALERTAS DE COMPROMISSOS (APPOINTMENTS)
// ---------------------------------------------------------
async function pollingAppointmentAlerts() {
  console.log('[ALERTAS] Verificando proximidade de horários...');

  const hoje = dayjs().tz(TZ).startOf('day');

  let issues = [];
  try {
    issues = await fetchRedmineIssues({
      limit: 100,
      status_id: '*',
      sort: 'due_date:asc,updated_on:desc'
    });
  } catch (error) {
    console.error(`[ALERTAS] Falha ao consultar Redmine: ${error.code || error.message}`);
    return;
  }

  for (const issue of issues) {
    try {
      const statusName = issue.status ? issue.status.name : '';
      if (statusName !== MEET_STATUS_NAME) continue;

      const issueDateStr = getIssueDate(issue);
      const issueTimeStr = getIssueTime(issue);

      if (!issueDateStr || !issueTimeStr) continue;

      const appointmentAt = parseAppointmentDateTime(issueDateStr, issueTimeStr);
      if (!appointmentAt) {
        console.warn(`[ALERTAS] Data/hora inválida na tarefa #${issue.id}: ${issueDateStr} ${issueTimeStr}`);
        continue;
      }

      // Ignora compromissos passados para reduzir leitura/escrita no Redis.
      if (appointmentAt.isBefore(dayjs().tz(TZ))) continue;

      const issueDate = appointmentAt.startOf('day');
      if (issueDate.isBefore(hoje)) continue;

      await trySendTimedAlert({
        issue,
        appointmentAt,
        channel: 'mattermost',
        minutesBefore: Number(ALERT_MINUTES_BEFORE),
        sendFn: sendMattermostAppointmentAlert
      });

      await trySendTimedAlert({
        issue,
        appointmentAt,
        channel: 'mattermost',
        minutesBefore: Number(ALERT_EXTRA_MINUTES_BEFORE),
        sendFn: sendMattermostAppointmentAlert
      });

      await trySendTimedAlert({
        issue,
        appointmentAt,
        channel: 'whatsapp',
        minutesBefore: Number(WHATSAPP_ALERT_MINUTES_BEFORE),
        sendFn: sendWhatsappAppointmentAlert
      });
    } catch (error) {
      console.error(`[ALERTAS] Falha ao processar tarefa #${issue && issue.id ? issue.id : 'desconhecida'}: ${error.code || error.message}`);
    }
  }
}

// ---------------------------------------------------------
// OUTRAS ROTINAS EM PARALELO (SUMMARIES E DRIVE MOVER)
// ---------------------------------------------------------
async function processDailySummary() {
  if (DAILY_SUMMARY_ENABLED !== 'true') return;
  if (!shouldRunAtConfiguredMinute(DAILY_SUMMARY_HOUR, DAILY_SUMMARY_MINUTE)) return;

  const targetDay = getNextBusinessDay();
  const targetDate = targetDay.format('YYYY-MM-DD');
  const today = dayjs().tz(TZ).format('YYYY-MM-DD');
  const summaryKey = `redmine:daily-summary:${targetDate}:sent-at:${today}`;

  if (await redis.get(summaryKey)) return;

  console.log(`[SUMMARY] Gerando resumo de compromissos de ${targetDate}...`);

  const issues = await fetchAwaitingDateIssues({ due_date: targetDate });
  const byUser = new Map();

  for (const issue of issues) {
    if ((issue.status && issue.status.name) !== MEET_STATUS_NAME) continue;

    const issueDateStr = getIssueDate(issue);
    const issueTimeStr = getIssueTime(issue);
    if (!issueDateStr || !issueTimeStr) continue;

    const appointmentAt = parseAppointmentDateTime(issueDateStr, issueTimeStr);
    if (!appointmentAt || appointmentAt.format('YYYY-MM-DD') !== targetDate) continue;

    const userId = await getMattermostUserIdFromIssue(issue);
    if (!userId) {
      console.warn(`[SUMMARY] Sem usuário Mattermost para a tarefa #${issue.id}.`);
      continue;
    }

    if (!byUser.has(userId)) byUser.set(userId, []);
    byUser.get(userId).push({ issue, appointmentAt });
  }

  for (const [userId, appointments] of byUser.entries()) {
    appointments.sort((a, b) => a.appointmentAt.valueOf() - b.appointmentAt.valueOf());

    const lines = appointments.map(({ issue, appointmentAt }) => {
      const url = `${REDMINE_URL}/issues/${issue.id}`;
      const estimated = issue.estimated_hours ? ` | estimado: ${issue.estimated_hours}h` : '';
      return `- ${appointmentAt.format('HH:mm')} - #${issue.id} ${issue.subject}${estimated}\n  ${url}`;
    });

    const message =
      `📅 **Resumo dos compromissos do próximo dia útil (${targetDay.format('DD/MM/YYYY')})**\n\n` +
      `Status: **${MEET_STATUS_NAME}**\n\n` +
      lines.join('\n');

    await sendMattermostDirectMessage(userId, message);
  }

  await redis.set(summaryKey, 'true', 'EX', 36 * 60 * 60);
  console.log(`[SUMMARY] Resumo concluído para ${byUser.size} usuário(s).`);
}
async function processClientMorningSummary() {
  // Confirmação por WhatsApp às 08:30 dos compromissos do próximo dia útil.
  // Regras:
  // - status Aguardando Data;
  // - tem data, horário e tempo estimado;
  // - tem campo "ID Grupo WhatsApp";
  // - dispara uma única vez por próximo dia útil.
  if (!shouldRunAtConfiguredTime(CLIENT_SUMMARY_TIME, '08:30')) return;

  if (!sock) {
    console.warn('[WHATSAPP SUMMARY] WhatsApp não inicializado; confirmação não enviada.');
    return;
  }

  const targetDay = getNextBusinessDay();
  const targetDate = targetDay.format('YYYY-MM-DD');
  const today = dayjs().tz(TZ).format('YYYY-MM-DD');
  const summaryKey = `redmine:whatsapp-client-summary:${targetDate}:sent-at:${today}`;

  if (await redis.get(summaryKey)) return;

  console.log(`[WHATSAPP SUMMARY] Gerando confirmações dos compromissos de ${targetDate}...`);

  const issues = await fetchAwaitingDateIssues({
    limit: 100,
    status_id: '*',
    sort: 'due_date:asc,updated_on:desc'
  });

  const byGroup = new Map();

  for (const issue of issues) {
    if ((issue.status && issue.status.name) !== MEET_STATUS_NAME) continue;

    const issueDateStr = getIssueDate(issue);
    const issueTimeStr = getIssueTime(issue);
    if (!issueDateStr || !issueTimeStr) continue;

    // A confirmação é somente para compromissos com tempo estimado.
    if (!issue.estimated_hours || Number(issue.estimated_hours) <= 0) continue;

    const appointmentAt = parseAppointmentDateTime(issueDateStr, issueTimeStr);
    if (!appointmentAt || appointmentAt.format('YYYY-MM-DD') !== targetDate) continue;

    const groupField = getCustomField(issue, WHATSAPP_GROUP_FIELD_NAME);
    const groupId = cleanValue(groupField && groupField.value);
    if (!groupId) {
      console.warn(`[WHATSAPP SUMMARY] Sem campo "${WHATSAPP_GROUP_FIELD_NAME}" para a tarefa #${issue.id}.`);
      continue;
    }

    if (!byGroup.has(groupId)) byGroup.set(groupId, []);
    byGroup.get(groupId).push({ issue, appointmentAt });
  }

  let sentCount = 0;

  for (const [groupId, appointments] of byGroup.entries()) {
    appointments.sort((a, b) => a.appointmentAt.valueOf() - b.appointmentAt.valueOf());

    const lines = appointments.map(({ issue, appointmentAt }) => {
      const url = `${REDMINE_URL}/issues/${issue.id}`;
      const estimated = issue.estimated_hours ? ` | estimado: ${issue.estimated_hours}h` : '';
      return `• ${appointmentAt.format('HH:mm')} - #${issue.id} ${issue.subject}${estimated}\n  ${url}`;
    });

    const message =
      `📅 Confirmação de compromisso\n\n` +
      `Compromisso(s) agendado(s) para o próximo dia útil (${targetDay.format('DD/MM/YYYY')}):\n\n` +
      lines.join('\n\n') +
      `\n\nPor favor, confirme o compromisso respondendo esta mensagem.`;

    await sock.sendMessage(groupId, { text: message });
    sentCount += 1;
  }

  await redis.set(summaryKey, 'true', 'EX', 36 * 60 * 60);
  console.log(`[WHATSAPP SUMMARY] Confirmações enviadas para ${sentCount} grupo(s).`);
}
async function processMeetRecordings() { /* Lógica existente do Google Drive */ }

// ---------------------------------------------------------
// INICIALIZADORES DOS LOOPS RECURSIVOS (TIMEOUT DINÂMICO)
// ---------------------------------------------------------
if (POLLING_ENABLED !== 'true') {
  console.log('[POLLING] Recursos de pooling globais desativados via ENV.');
} else {
  console.log('[POLLING] Inicializando loops com gerenciamento de janelas comerciais ativo.');

  // Loop inteligente para as Tasks Gerais do Redmine
  function loopRedmine() {
    pollingRedmineIssues()
      .catch(err => console.error('[POLLING ERRO]:', err.message))
      .finally(() => {
        const proximoIntervalo = getDynamicPollingIntervalInSeconds();
        setTimeout(loopRedmine, proximoIntervalo * 1000);
      });
  }

  // Loop inteligente para Alertas de Compromissos
  function loopAlertas() {
    pollingAppointmentAlerts()
      .catch(err => console.error('[ALERTAS ERRO]:', err.message))
      .finally(() => {
        const proximoIntervalo = getDynamicPollingIntervalInSeconds();
        setTimeout(loopAlertas, proximoIntervalo * 1000);
      });
  }

  // Dispara a primeira execução imediata dos loops
  loopRedmine();
  loopAlertas();
}

// Manutenção dos processos secundários estruturados de hora em hora/minuto fixo
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