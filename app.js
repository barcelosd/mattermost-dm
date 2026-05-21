require('dotenv').config();

const express = require('express');
const axios = require('axios');
const Redis = require('ioredis');
const { google } = require('googleapis');

const app = express();

app.use(express.text({ type: '*/*' }));

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

  ALERT_MINUTES_BEFORE = 10,
  ALERT_FIELD_NAME = 'Horário',
  ALERT_POLLING_INTERVAL_SECONDS = 60,
  ALERT_TIMEZONE_OFFSET = '-03:00',

  IGNORE_STATUSES = 'Rejeitado,Fechado,Resolvido',

  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REFRESH_TOKEN,
  GOOGLE_CALENDAR_ID,

  GOOGLE_MEET_FIELD_NAME = 'Google Meet',
  GOOGLE_MEET_STATUS_NAME = 'Aguardando Data',
  GOOGLE_MEET_PROJECT_FIELD_NAME = 'Nome Fantasia'

} = process.env;

const redis = REDIS_URL
  ? new Redis(REDIS_URL, {
      maxRetriesPerRequest: 1,
      enableReadyCheck: false
    })
  : null;

const mattermostHeaders = {
  Authorization: `Bearer ${MATTERMOST_TOKEN}`,
  'Content-Type': 'application/json'
};

const redmineHeaders = {
  'X-Redmine-API-Key': REDMINE_API_KEY,
  'Content-Type': 'application/json'
};

const issueAssigneeCache = new Map();

let lastPollingTimestamp =
  Date.now() - (10 * 60 * 1000);

function normalizeText(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function shouldIgnoreIssueByStatus(issue) {
  const status =
    issue?.status?.name ||
    issue?.status ||
    '';

  const ignored = String(IGNORE_STATUSES)
    .split(',')
    .map(s => normalizeText(s));

  return ignored.includes(normalizeText(status));
}

function getPayloadData(body) {
  if (!body) return {};

  try {
    const parsed = JSON.parse(body);

    if (parsed.payload) {
      if (typeof parsed.payload === 'string') {
        return JSON.parse(parsed.payload);
      }

      return parsed.payload;
    }

    return parsed;
  } catch {
    return {};
  }
}

function getCustomFieldValue(entity, fieldName) {
  const fields =
    entity?.custom_fields ||
    entity?.custom_field_values ||
    [];

  const field = fields.find(f =>
    f.name === fieldName ||
    f.custom_field_name === fieldName
  );

  return field?.value || null;
}

function getCustomFieldId(issue, fieldName) {
  const fields =
    issue?.custom_fields ||
    issue?.custom_field_values ||
    [];

  const field = fields.find(f =>
    f.name === fieldName ||
    f.custom_field_name === fieldName
  );

  return field?.id || field?.custom_field_id || null;
}

async function updateRedmineCustomField(issue, fieldName, value) {
  const fieldId = getCustomFieldId(issue, fieldName);

  if (!fieldId) {
    console.log(`Campo não encontrado: ${fieldName}`);
    return;
  }

  await axios.put(
    `${REDMINE_URL}/issues/${issue.id}.json`,
    {
      issue: {
        custom_fields: [
          {
            id: fieldId,
            value
          }
        ]
      }
    },
    { headers: redmineHeaders }
  );
}

async function redisGet(key) {
  if (!redis) return null;

  return await redis.get(key);
}

async function redisSet(key, value) {
  if (!redis) return;

  const ttl =
    Number(REDIS_TTL_DAYS) *
    24 *
    60 *
    60;

  await redis.set(key, value, 'EX', ttl);
}

async function wasAlreadyNotified(key) {
  if (!redis) return false;

  const exists = await redis.get(key);

  return exists === '1';
}

async function markAsNotified(key) {
  if (!redis) return;

  const ttl =
    Number(REDIS_TTL_DAYS) *
    24 *
    60 *
    60;

  await redis.set(key, '1', 'EX', ttl);
}

function getLastJournal(issue) {
  if (
    Array.isArray(issue.journals) &&
    issue.journals.length > 0
  ) {
    return issue.journals[
      issue.journals.length - 1
    ];
  }

  return null;
}

function getEventKey(issue, source, journal = null) {
  if (journal?.id) {
    return `redmine:event:${issue.id}:journal:${journal.id}`;
  }

  return `redmine:event:${issue.id}:updated:${issue.updated_on}`;
}

async function getMattermostBotUser() {
  const response = await axios.get(
    `${MATTERMOST_URL}/api/v4/users/me`,
    { headers: mattermostHeaders }
  );

  return response.data;
}

async function getMattermostUserByEmail(email) {
  const response = await axios.get(
    `${MATTERMOST_URL}/api/v4/users/email/${encodeURIComponent(email)}`,
    { headers: mattermostHeaders }
  );

  return response.data;
}

async function createDirectChannel(botUserId, targetUserId) {
  const response = await axios.post(
    `${MATTERMOST_URL}/api/v4/channels/direct`,
    [botUserId, targetUserId],
    { headers: mattermostHeaders }
  );

  return response.data;
}

async function sendMattermostMessage(channelId, message) {
  await axios.post(
    `${MATTERMOST_URL}/api/v4/posts`,
    {
      channel_id: channelId,
      message
    },
    { headers: mattermostHeaders }
  );
}

async function getRedmineUser(userId) {
  const response = await axios.get(
    `${REDMINE_URL}/users/${userId}.json`,
    { headers: redmineHeaders }
  );

  return response.data.user;
}

async function getRedmineGroup(groupId) {
  try {
    const response = await axios.get(
      `${REDMINE_URL}/groups/${groupId}.json?include=users`,
      { headers: redmineHeaders }
    );

    return response.data.group;
  } catch {
    return null;
  }
}

async function getResponsibleTargets(issue) {
  const assignee =
    issue.assignee ||
    issue.assigned_to;

  if (!assignee) return [];

  if (
    typeof assignee.id === 'string' &&
    assignee.id.includes('@')
  ) {
    return [{
      email: assignee.id.trim().toLowerCase(),
      name: assignee.name
    }];
  }

  try {
    const user = await getRedmineUser(
      assignee.id
    );

    if (user?.mail) {
      return [{
        email: user.mail
          .trim()
          .toLowerCase(),
        name:
          `${user.firstname || ''} ${user.lastname || ''}`.trim()
      }];
    }
  } catch {}

  const group = await getRedmineGroup(
    assignee.id
  );

  if (!group?.users?.length) {
    return [];
  }

  const users = [];

  for (const groupUser of group.users) {
    try {
      const fullUser =
        await getRedmineUser(groupUser.id);

      if (fullUser?.mail) {
        users.push({
          email: fullUser.mail
            .trim()
            .toLowerCase(),
          name:
            `${fullUser.firstname || ''} ${fullUser.lastname || ''}`.trim()
        });
      }
    } catch {}
  }

  return users;
}

async function notifyTargets(targets, message) {
  const botUser =
    await getMattermostBotUser();

  for (const target of targets) {
    try {
      const mmUser =
        await getMattermostUserByEmail(
          target.email
        );

      const channel =
        await createDirectChannel(
          botUser.id,
          mmUser.id
        );

      await sendMattermostMessage(
        channel.id,
        message
      );

      console.log(
        `Mensagem enviada para ${target.email}`
      );

    } catch (error) {
      console.error(
        `Erro enviando para ${target.email}:`,
        error.response?.data ||
        error.message
      );
    }
  }
}

function googleCalendarIsConfigured() {
  return Boolean(
    GOOGLE_CLIENT_ID &&
    GOOGLE_CLIENT_SECRET &&
    GOOGLE_REFRESH_TOKEN &&
    GOOGLE_CALENDAR_ID
  );
}

function getGoogleCalendarClient() {
  const auth = new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET
  );

  auth.setCredentials({
    refresh_token: GOOGLE_REFRESH_TOKEN
  });

  return google.calendar({
    version: 'v3',
    auth
  });
}

async function getRedmineProject(projectId) {
  try {
    const response = await axios.get(
      `${REDMINE_URL}/projects/${projectId}.json`,
      { headers: redmineHeaders }
    );

    return response.data.project;
  } catch {
    return null;
  }
}

async function getMeetProjectName(issue) {
  const project =
    await getRedmineProject(
      issue.project.id
    );

  const nomeFantasia =
    getCustomFieldValue(
      project,
      GOOGLE_MEET_PROJECT_FIELD_NAME
    );

  if (nomeFantasia) {
    return nomeFantasia;
  }

  return (
    project?.parent?.name ||
    project?.name ||
    issue.project?.name ||
    ''
  );
}

function parseTimeText(timeText) {
  if (!timeText) return null;

  const match =
    String(timeText)
      .trim()
      .match(/(\d{1,2})h(\d{2})/);

  if (!match) return null;

  return {
    hour: Number(match[1]),
    minute: Number(match[2])
  };
}

function createDateFromRedmineDateTime(date, time) {
  const [year, month, day] =
    date.split('-').map(Number);

  return new Date(
    year,
    month - 1,
    day,
    time.hour,
    time.minute,
    0
  );
}

function parseAppointmentDateTime(issue) {
  const date =
    issue.start_date ||
    issue.due_date;

  const timeValue =
    getCustomFieldValue(
      issue,
      ALERT_FIELD_NAME
    );

  if (!date || !timeValue) {
    return null;
  }

  const parsed =
    parseTimeText(timeValue);

  if (!parsed) return null;

  return createDateFromRedmineDateTime(
    date,
    parsed
  );
}

function getEstimatedMinutes(issue) {
  const hours =
    Number(issue.estimated_hours || 0);

  return Math.round(hours * 60);
}

async function findGoogleEventForIssue(calendar, issueId) {
  const response =
    await calendar.events.list({
      calendarId: GOOGLE_CALENDAR_ID,
      q: `#${issueId}`,
      maxResults: 10
    });

  return (
    response.data.items?.find(event =>
      event.summary?.startsWith(
        `#${issueId}`
      )
    ) || null
  );
}

function extractMeetLink(event) {
  return (
    event.hangoutLink ||
    event.conferenceData
      ?.entryPoints?.[0]?.uri ||
    null
  );
}

async function processGoogleMeet(issue) {
  if (!googleCalendarIsConfigured()) {
    return;
  }

  if (
    normalizeText(
      issue.status?.name
    ) !==
    normalizeText(
      GOOGLE_MEET_STATUS_NAME
    )
  ) {
    return;
  }

  const startDate =
    parseAppointmentDateTime(issue);

  if (!startDate) {
    return;
  }

  const estimatedMinutes =
    getEstimatedMinutes(issue);

  if (!estimatedMinutes) {
    return;
  }

  const endDate = new Date(
    startDate.getTime() +
    estimatedMinutes * 60000
  );

  const projectName =
    await getMeetProjectName(issue);

  const timeText =
    getCustomFieldValue(
      issue,
      ALERT_FIELD_NAME
    );

  const summary =
    `#${issue.id} - ${projectName} - ${issue.subject} - ${timeText}`;

  const signature = JSON.stringify({
    summary,
    start: startDate.toISOString(),
    end: endDate.toISOString()
  });

  const signatureKey =
    `redmine:meet:signature:${issue.id}`;

  const oldSignature =
    await redisGet(signatureKey);

  const calendar =
    getGoogleCalendarClient();

  let event =
    await findGoogleEventForIssue(
      calendar,
      issue.id
    );

  if (
    event &&
    oldSignature === signature
  ) {
    return;
  }

  const requestBody = {
    summary,
    description:
      `${REDMINE_URL}/issues/${issue.id}`,

    start: {
      dateTime:
        startDate.toISOString()
    },

    end: {
      dateTime:
        endDate.toISOString()
    }
  };

  if (event?.id) {
    const response =
      await calendar.events.patch({
        calendarId:
          GOOGLE_CALENDAR_ID,

        eventId: event.id,

        conferenceDataVersion: 1,

        requestBody
      });

    event = response.data;

    console.log(
      `Meet atualizado issue #${issue.id}`
    );

  } else {

    const response =
      await calendar.events.insert({
        calendarId:
          GOOGLE_CALENDAR_ID,

        conferenceDataVersion: 1,

        requestBody: {
          ...requestBody,

          conferenceData: {
            createRequest: {
              requestId:
                `redmine-${issue.id}-${Date.now()}`,

              conferenceSolutionKey: {
                type: 'hangoutsMeet'
              }
            }
          }
        }
      });

    event = response.data;

    console.log(
      `Meet criado issue #${issue.id}`
    );
  }

  const meetLink =
    extractMeetLink(event);

  if (meetLink) {
    await updateRedmineCustomField(
      issue,
      GOOGLE_MEET_FIELD_NAME,
      meetLink
    );
  }

  await redisSet(
    signatureKey,
    signature
  );
}

function buildNotificationMessage(
  issue,
  action,
  source
) {
  const meetLink =
    getCustomFieldValue(
      issue,
      GOOGLE_MEET_FIELD_NAME
    );

  return [
    `### Notificação do Redmine`,
    ``,
    `**Origem:** ${source}`,
    `**Ação:** ${action}`,
    `**Projeto:** ${issue.project?.name || ''}`,
    `**Assunto:** ${issue.subject}`,
    `**Status:** ${issue.status?.name || ''}`,
    `**Prioridade:** ${issue.priority?.name || ''}`,
    meetLink
      ? `**Google Meet:** ${meetLink}`
      : null,
    ``,
    `[Abrir tarefa no Redmine](${REDMINE_URL}/issues/${issue.id})`
  ]
    .filter(Boolean)
    .join('\n');
}

async function processIssueNotification(
  issue,
  action,
  source,
  forceNotify = false,
  journal = null
) {
  if (
    shouldIgnoreIssueByStatus(issue)
  ) {
    return;
  }

  await processGoogleMeet(issue);

  const eventKey =
    getEventKey(
      issue,
      source,
      journal
    );

  if (
    await wasAlreadyNotified(
      eventKey
    )
  ) {
    return;
  }

  const targets =
    await getResponsibleTargets(
      issue
    );

  if (!targets.length) {
    return;
  }

  const message =
    buildNotificationMessage(
      issue,
      action,
      source
    );

  await notifyTargets(
    targets,
    message
  );

  await markAsNotified(
    eventKey
  );
}

async function fetchIssueDetails(issueId) {
  const response = await axios.get(
    `${REDMINE_URL}/issues/${issueId}.json`,
    {
      headers: redmineHeaders,
      params: {
        include: 'journals'
      }
    }
  );

  return response.data.issue;
}

async function fetchRecentIssues() {
  const response = await axios.get(
    `${REDMINE_URL}/issues.json`,
    {
      headers: redmineHeaders,
      params: {
        status_id: '*',
        sort: 'updated_on:desc',
        limit: 20
      }
    }
  );

  return response.data.issues || [];
}

async function pollingRedmineIssues() {
  console.log(
    'Polling Redmine iniciado.'
  );

  try {

    const issues =
      await fetchRecentIssues();

    for (const issueSummary of issues) {

      const updatedAt =
        new Date(
          issueSummary.updated_on
        ).getTime();

      if (
        updatedAt <
        lastPollingTimestamp
      ) {
        continue;
      }

      try {

        const issue =
          await fetchIssueDetails(
            issueSummary.id
          );

        const issueWithUrl = {
          ...issue,
          url:
            `${REDMINE_URL}/issues/${issue.id}`
        };

        await processGoogleMeet(
          issueWithUrl
        );

        const lastJournal =
          getLastJournal(
            issueWithUrl
          );

        const eventKey =
          getEventKey(
            issueWithUrl,
            'Polling',
            lastJournal
          );

        if (
          await wasAlreadyNotified(
            eventKey
          )
        ) {
          continue;
        }

        await processIssueNotification(
          issueWithUrl,
          'Responsável alterado ou verificação periódica',
          'Polling',
          false,
          lastJournal
        );

      } catch (errorIssue) {

        console.error(
          `Erro polling issue #${issueSummary.id}:`,
          errorIssue.response?.data ||
          errorIssue.message
        );
      }
    }

    lastPollingTimestamp =
      Date.now();

  } catch (error) {

    console.error(
      'Erro geral polling:',
      error.response?.data ||
      error.message
    );
  }
}

app.post(
  '/redmine-webhook',
  async (req, res) => {

    try {

      const payload =
        getPayloadData(
          req.body
        );

      const issue =
        payload.issue;

      const action =
        payload.action ||
        'updated';

      const journal =
        payload.journal ||
        null;

      if (!issue) {
        return res.status(200).json({
          message:
            'Payload sem issue.'
        });
      }

      await processIssueNotification(
        issue,
        action,
        'Webhook',
        true,
        journal
      );

      return res.status(200).json({
        success: true
      });

    } catch (error) {

      console.error(
        'Erro webhook:',
        error.response?.data ||
        error.message
      );

      return res.status(500).json({
        success: false,
        error:
          error.response?.data ||
          error.message
      });
    }
  }
);

app.get('/', (req, res) => {
  res.send(
    'API Redmine → Mattermost funcionando.'
  );
});

app.listen(PORT, () => {

  console.log(
    `Servidor rodando porta ${PORT}`
  );

  if (
    POLLING_ENABLED === 'true'
  ) {

    setTimeout(
      pollingRedmineIssues,
      10000
    );

    setInterval(
      pollingRedmineIssues,
      Number(
        POLLING_INTERVAL_SECONDS
      ) * 1000
    );

    setInterval(
      pollingRedmineIssues,
      Number(
        ALERT_POLLING_INTERVAL_SECONDS
      ) * 1000
    );
  }
});