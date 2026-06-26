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
  ALERT_POLLING_INTERVAL_SECONDS = 60
} = process.env;

const app = express();
app.use(express.json());

const redis = new Redis(REDIS_URL);
let sock = null; // Instância do WhatsApp Baileys

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
async function pollingAppointmentAlerts() {
  console.log('[ALERTAS] Verificando proximidade de horários...');

  const response = await axios.get(`${REDMINE_URL}/issues.json`, {
    headers: { 'X-Redmine-API-Key': REDMINE_API_KEY },
    params: { limit: POLLING_LIMIT }
  });

  const issues = response.data.issues || [];
  const hoje = dayjs().tz('America/Sao_Paulo').startOf('day');

  for (const issue of issues) {
    const customFields = issue.custom_fields || [];
    const dateField = customFields.find(f => f.name === 'Data');
    const timeField = customFields.find(f => f.name === ALERT_FIELD_NAME);

    const issueDateStr = dateField ? dateField.value : issue.due_date;
    
    // -------------------------------------------------------------------------
    // CRITÉRIO DE EXCLUSÃO: IGNORAR CASO NÃO SEJA HOJE OU FUTURO
    // -------------------------------------------------------------------------
    if (!issueDateStr || !timeField || !timeField.value) {
      continue;
    }

    const issueDate = dayjs(issueDateStr).tz('America/Sao_Paulo').startOf('day');
    if (issueDate.isBefore(hoje)) {
      continue; // Ignora o passado imediatamente, poupando chamadas ao Redis abaixo
    }
    // -------------------------------------------------------------------------

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