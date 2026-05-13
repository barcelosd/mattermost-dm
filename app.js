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

function getIssueFromPayload(body) {
  console.log('Body bruto recebido:');
  console.log(body);

  let data = body;

  if (typeof body === 'string') {
    try {
      data = JSON.parse(body);
    } catch {
      const params = new URLSearchParams(body);

      if (params.has('payload')) {
        try {
          data = JSON.parse(params.get('payload'));
        } catch {
          return null;
        }
      } else {
        return null;
      }
    }
  }

  if (data.issue) return data.issue;
  if (data.payload?.issue) return data.payload.issue;
  if (data.webhook?.issue) return data.webhook.issue;

  return null;
}

app.post('/redmine-webhook', async (req, res) => {
  console.log('Headers recebidos:');
  console.log(req.headers);

  console.log('Body recebido:');
  console.log(req.body);

  try {
    const issue = getIssueFromPayload(req.body);

    if (!issue) {
      return res.status(200).json({
        message: 'Payload recebido, mas sem issue.'
      });
    }

    if (!issue.assigned_to || !issue.assigned_to.id) {
      return res.status(200).json({
        message: 'Tarefa sem responsável.'
      });
    }

    const issueId = issue.id;
    const subject = issue.subject || 'Sem assunto';
    const assignedUserId = issue.assigned_to.id;

    const email = await getRedmineUserEmail(assignedUserId);
    const mattermostUser = await getMattermostUserByEmail(email);
    const botUser = await getMattermostBotUser();

    const directChannel = await createDirectChannel(
      botUser.id,
      mattermostUser.id
    );

    const issueUrl = `${REDMINE_URL}/issues/${issueId}`;

    const message = [
      `### Nova notificação do Redmine`,
      ``,
      `Você é o responsável pela tarefa **#${issueId}**.`,
      ``,
      `**Assunto:** ${subject}`,
      ``,
      `[Abrir tarefa no Redmine](${issueUrl})`
    ].join('\n');

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

app.use((err, req, res, next) => {
  console.error('Erro ao ler requisição recebida:');
  console.error(err.message);

  res.status(400).json({
    message: 'Erro ao ler requisição recebida.',
    error: err.message
  });
});

app.get('/', (req, res) => {
  res.send('API Redmine → Mattermost funcionando.');
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});