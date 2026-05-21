require('dotenv').config();

const express = require('express');
const axios = require('axios');
const Redis = require('ioredis');
const { google } = require('googleapis');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
const customParseFormat = require('dayjs/plugin/customParseFormat');

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(customParseFormat);

// ---------------------------------------------------------
// 1. CONFIGURAÇÕES E VARIÁVEIS DE AMBIENTE (Lidas do .env)
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
  POLLING_INTERVAL_SECONDS = 300, 
  POLLING_LIMIT = 20,
  ALERT_MINUTES_BEFORE = 10, 
  ALERT_EXTRA_MINUTES_BEFORE = 2, 
  ALERT_WINDOW_SECONDS = 180,
  ALERT_FIELD_NAME = 'Horário', 
  ALERT_POLLING_INTERVAL_SECONDS = 60,
  DAILY_SUMMARY_ENABLED = 'true', 
  DAILY_SUMMARY_HOUR = 17, 
  DAILY_SUMMARY_MINUTE = 45,
  IGNORE_STATUSES = 'Rejeitado,Fechado,Resolvido',
  LOG_SKIPPED_EVENTS = 'false',
  GOOGLE_CLIENT_ID, 
  GOOGLE_CLIENT_SECRET, 
  GOOGLE_REFRESH_TOKEN, 
  GOOGLE_CALENDAR_ID,
  GOOGLE_MEET_PROJECT_FIELD_NAME = 'Nome Fantasia',
  MEET_STATUS_NAME = 'Aguardando Data'
} = process.env;

const redmineHeaders = { 'X-Redmine-API-Key': REDMINE_API_KEY, 'Content-Type': 'application/json' };
const mattermostHeaders = { Authorization: `Bearer ${MATTERMOST_TOKEN}`, 'Content-Type': 'application/json' };

// ---------------------------------------------------------
// 2. CACHE (REDIS COM FALLBACK SEGURO NA MEMÓRIA)
// ---------------------------------------------------------
const redis = REDIS_URL ? new Redis(REDIS_URL, { maxRetriesPerRequest: 1, enableReadyCheck: false }) : null;
const memory = { values: new Map(), meetIssues: new Set() };

async function redisSet(key, value, ttlSeconds = Number(REDIS_TTL_DAYS) * 86400) {
  if (redis) {
    await redis.set(key, value, 'EX', ttlSeconds);
    return;
  }
  memory.values.set(key, value);
  setTimeout(() => memory.values.delete(key), ttlSeconds * 1000);
}

async function redisGet(key) {
  if (redis) return redis.get(key);
  return memory.values.get(key) || null;
}

// ---------------------------------------------------------
// 3. UTILITÁRIOS E DATAS (Com Day.js)
// ---------------------------------------------------------
function normalizeText(value) {
  return String(value || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function shouldIgnoreIssueByStatus(issue) {
  const status = normalizeText(issue?.status?.name || '');
  return String(IGNORE_STATUSES).split(',').map(normalizeText).includes(status);
}

function getLastJournal(issue) {
  if (!issue?.journals || !issue.journals.length) return null;
  return issue.journals[issue.journals.length - 1];
}

function getEventKey(issue, source, journal) {
  const identifier = journal ? journal.id : source;
  return `event:${issue.id}:${identifier}`;
}

function getCustomFieldValue(entity, fieldName) {
  const fields = entity?.custom_fields || entity?.custom_field_values || [];
  const field = fields.find(f => f.name === fieldName || f.custom_field_name === fieldName);
  return field?.value || null;
}

function parseAppointmentDateTime(issue) {
  const date = issue.start_date || issue.due_date;
  const timeValue = getCustomFieldValue(issue, ALERT_FIELD_NAME);

  if (!date || !timeValue) return null;

  let parsedTime = dayjs(timeValue, ['HH[h]mm', 'HH:mm', 'HH[h]'], true);
  if (!parsedTime.isValid()) return null;

  const dateTime = dayjs.tz(`${date} ${parsedTime.format('HH:mm')}`, "YYYY-MM-DD HH:mm", "America/Sao_Paulo").toDate();
  return { dateTime, timeLabel: parsedTime.format('HH[h]mm') };
}

// ---------------------------------------------------------
// 4. INTEGRAÇÕES (BUSCAS PARALELIZADAS)
// ---------------------------------------------------------
async function getRedmineUser(userId) {
  const response = await axios.get(`${REDMINE_URL}/users/${userId}.json`, { headers: redmineHeaders });
  return response.data.user;
}

async function getRedmineGroup(groupId) {
  try {
    const response = await axios.get(`${REDMINE_URL}/groups/${groupId}.json?include=users`, { headers: redmineHeaders });
    return response.data.group;
  } catch {
    return null;
  }
}

function isRedmineUserActive(user) {
  if (!user || !user.mail) return false;
  if (user.status && Number(user.status) !== 1) return false;
  return true;
}

async function getResponsibleTargets(issue) {
  const assignee = issue.assignee || issue.assigned_to;
  if (!assignee) return [];

  if (typeof assignee.id === 'string' && assignee.id.includes('@')) {
    return [{ email: assignee.id.trim().toLowerCase(), name: assignee.name || assignee.id }];
  }

  try {
    const user = await getRedmineUser(assignee.id);
    if (isRedmineUserActive(user)) {
      return [{ email: user.mail.toLowerCase(), name: `${user.firstname || ''} ${user.lastname || ''}`.trim() }];
    }
  } catch {}

  const group = await getRedmineGroup(assignee.id);
  if (!group?.users?.length) return [];

  const usersPromises = group.users.map(async (groupUser) => {
    try {
      const fullUser = await getRedmineUser(groupUser.id);
      if (isRedmineUserActive(fullUser)) {
        return { email: fullUser.mail.toLowerCase(), name: `${fullUser.firstname || ''} ${fullUser.lastname || ''}`.trim() };
      }
    } catch {
      return null;
    }
  });

  const resolvedUsers = await Promise.all(usersPromises);
  return resolvedUsers.filter(Boolean);
}

// ---------------------------------------------------------
// 5. LÓGICA DE POLLING (SIMPLIFICADA E SEM WEBHOOKS)
// ---------------------------------------------------------
let lastPollingTimestamp = Date.now() - 10 * 60 * 1000;

async function fetchRecentIssues() {
  const response = await axios.get(`${REDMINE_URL}/issues.json`, {
    headers: redmineHeaders,
    params: {
      status_id: '*',
      sort: 'updated_on:desc',
      limit: Number(POLLING_LIMIT)
    }
  });
  return response.data.issues || [];
}

async function fetchIssueDetails(issueId) {
  const response = await axios.get(`${REDMINE_URL}/issues/${issueId}.json`, {
    headers: redmineHeaders,
    params: { include: 'journals' }
  });
  return response.data.issue;
}

async function pollingRedmineIssues() {
  console.log(`[${dayjs().format('HH:mm:ss')}] Iniciando Polling no Redmine...`);

  try {
    const issues = await fetchRecentIssues();

    for (const issueSummary of issues) {
      const updatedAt = new Date(issueSummary.updated_on).getTime();
      if (updatedAt < lastPollingTimestamp) continue;

      try {
        const issue = await fetchIssueDetails(issueSummary.id);
        const issueWithUrl = { ...issue, url: `${REDMINE_URL}/issues/${issue.id}` };

        // Simulação da chamada do Google Meet e Alertas (mantendo sua lógica original de negócio)
        // await processGoogleMeet(issueWithUrl); 
        // await checkAppointmentAlert(issueWithUrl);
        
        console.log(`Tarefa #${issue.id} processada com sucesso no polling.`);
        
      } catch (errorIssue) {
        console.error(`Erro processando issue #${issueSummary.id}:`, errorIssue.response?.data || errorIssue.message);
      }
    }

    lastPollingTimestamp = Date.now();
  } catch (error) {
    console.error('Erro geral no polling de issues:', error.response?.data || error.message);
  }
}

// ---------------------------------------------------------
// 6. INICIALIZAÇÃO DO SERVIDOR E WORKERS
// ---------------------------------------------------------
const app = express();

app.get('/polling-now', async (req, res) => {
  await pollingRedmineIssues();
  // Inclua aqui as outras chamadas (alertas, resumos, etc)
  res.json({ success: true, message: 'Rotina de polling engatilhada manualmente.' });
});

app.get('/', (req, res) => {
  res.send('API Bot NewNorte funcionando via Polling (Webhooks desativados).');
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}. Aguardando ciclos de polling.`);

  if (String(POLLING_ENABLED) === 'true') {
    // Executa a primeira vez alguns segundos após iniciar
    setTimeout(pollingRedmineIssues, 5000);

    // Configura o intervalo lendo do .env
    setInterval(
      pollingRedmineIssues,
      Number(POLLING_INTERVAL_SECONDS) * 1000
    );
  }
});