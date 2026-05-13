require('dotenv').config();

const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json({ type: '*/*' }));

app.use((err, req, res, next) => {
  console.error('Erro ao ler JSON recebido:');
  console.error(err.message);
  res.status(400).json({
    message: 'JSON inválido recebido.',
    error: err.message
  });
});

app.post('/redmine-webhook', async (req, res) => {
  console.log('Headers recebidos:');
  console.log(req.headers);

  console.log('Body recebido:');
  console.log(JSON.stringify(req.body, null, 2));

  try {

const {
  PORT,
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

app.post('/redmine-webhook', async (req, res) => {
  try {
    const issue = req.body.issue;

    if (!issue) {
      return res.status(200).json({ message: 'Payload sem issue.' });
    }

    if (!issue.assigned_to || !issue.assigned_to.id) {
      return res.status(200).json({ message: 'Tarefa sem responsável.' });
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