require('dotenv').config();

const express = require('express');
const axios = require('axios');

const app = express();

app.use(express.text({ type: '*/*' }));

const {
  PORT = 3000,
  REDMINE_URL,
  REDMINE_API_KEY,
  MATTERMOST_URL,
  MATTERMOST_TOKEN
} = process.env;

const mattermostHeaders = {
  Authorization: `Bearer ${MATTERMOST_TOKEN}`,
  'Content-Type': 'application/json'
};

const redmineHeaders = {
  'X-Redmine-API-Key': REDMINE_API_KEY,
  'Content-Type': 'application/json'
};

function parseBody(rawBody) {
  if (!rawBody) return {};

  if (typeof rawBody !== 'string') {
    return rawBody;
  }

  try {
    return JSON.parse(rawBody);
  } catch {
    const params = new URLSearchParams(rawBody);

    if (params.has('payload')) {
      try {
        return {
          payload: JSON.parse(params.get('payload'))
        };
      } catch {
        return {};
      }
    }

    return {};
  }
}

function getIssueFromPayload(body) {
  const data = parseBody(body);

  console.log('Payload convertido:');
  console.log(JSON.stringify(data, null, 2));

  if (data.issue) return data.issue;

  if (data.payload) {
    if (typeof data.payload === 'string') {
      try {
        const parsedPayload = JSON.parse(data.payload);
        return parsedPayload.issue || null;
      } catch {
        return null;
      }
    }

    return data.payload.issue || null;
  }

  if (data.webhook?.issue) return data.webhook.issue;

  return null;
}

function getActionFromPayload(body) {
  const data = parseBody(body);

  if (data.action) return data.action;

  if (data.payload) {
    if (typeof data.payload === 'string') {
      try {
        const parsedPayload = JSON.parse(data.payload);
        return parsedPayload.action || null;
      } catch {
        return null;
      }
    }

    return data.payload.action || null;
  }

  return null;
}

async function getRedmineUserEmail(userId) {
  const response = await axios.get(
    `${REDMINE_URL}/users/${userId}.json`,
    { headers: redmineHeaders }
  );

  return response.data.user.mail;
}

async function getMattermostUserByEmail(email) {
  const response = await axios.get(
    `${MATTERMOST_URL}/api/v4/users/email/${encodeURIComponent(email)}`,
    { headers: mattermostHeaders }
  );

  return response.data;
}

async function getMattermostBotUser() {
  const response = await axios.get(
    `${MATTERMOST_URL}/api/v4/users/me`,
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

async function getResponsibleEmail(issue) {
  if (issue.assignee?.mail) {
    return issue.assignee.mail;
  }

  if (issue.assigned_to?.mail) {
    return issue.assigned_to.mail;
  }

  if (
    typeof issue.assigned_to?.id === 'string' &&
    issue.assigned_to.id.includes('@')
  ) {
    return issue.assigned_to.id;
  }

  if (issue.assigned_to?.id) {
    return await getRedmineUserEmail(issue.assigned_to.id);
  }

  return null;
}

app.post('/redmine-webhook', async (req, res) => {
  console.log('Headers recebidos:');
  console.log(req.headers);

  console.log('Body bruto recebido:');
  console.log(req.body);

  try {
    const issue = getIssueFromPayload(req.body);
    const action = getActionFromPayload(req.body);

    if (!issue) {
      return res.status(200).json({
        message: 'Payload recebido, mas sem issue.'
      });
    }

    const email = await getResponsibleEmail(issue);

    if (!email) {
      return res.status(200).json({
        message: 'Tarefa sem responsável ou sem e-mail.'
      });
    }

    console.log('E-mail usado para buscar no Mattermost:', email);

    const mattermostUser = await getMattermostUserByEmail(email);
    const botUser = await getMattermostBotUser();

    const directChannel = await createDirectChannel(
      botUser.id,
      mattermostUser.id
    );

    const issueId = issue.id;
    const subject = issue.subject || 'Sem assunto';
    const status = issue.status?.name || issue.status || '';
    const priority = issue.priority?.name || issue.priority || '';
    const project = issue.project?.name || issue.project || '';
    const url = issue.url || `${REDMINE_URL}/issues/${issueId}`;

    const message = [
      `### Notificação do Redmine`,
      ``,
      `Você é o responsável pela tarefa **#${issueId}**.`,
      ``,
      `**Ação:** ${action || 'Atualização'}`,
      `**Projeto:** ${project}`,
      `**Assunto:** ${subject}`,
      status ? `**Status:** ${status}` : null,
      priority ? `**Prioridade:** ${priority}` : null,
      ``,
      `[Abrir tarefa no Redmine](${url})`
    ].filter(Boolean).join('\n');

    await sendMattermostMessage(directChannel.id, message);

    return res.status(200).json({
      message: 'Notificação enviada com sucesso.',
      email
    });

  } catch (error) {
    console.error('Erro detalhado:');
    console.error(error.response?.status);
    console.error(error.response?.data || error.message);

    return res.status(500).json({
      message: 'Erro ao processar webhook.',
      error: error.response?.data || error.message
    });
  }
});

app.get('/', (req, res) => {
  res.send('API Redmine → Mattermost funcionando.');
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});