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

  if (typeof rawBody !== 'string') return rawBody;

  try {
    return JSON.parse(rawBody);
  } catch {
    const params = new URLSearchParams(rawBody);

    if (params.has('payload')) {
      try {
        return { payload: JSON.parse(params.get('payload')) };
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
  if (data.payload?.issue) return data.payload.issue;
  if (data.webhook?.issue) return data.webhook.issue;

  return null;
}

function getActionFromPayload(body) {
  const data = parseBody(body);

  if (data.action) return data.action;
  if (data.payload?.action) return data.payload.action;

  return null;
}

async function getRedmineUser(userId) {
  const response = await axios.get(
    `${REDMINE_URL}/users/${userId}.json`,
    { headers: redmineHeaders }
  );

  return response.data.user;
}

async function getRedmineGroup(groupId) {
  const response = await axios.get(
    `${REDMINE_URL}/groups/${groupId}.json?include=users`,
    { headers: redmineHeaders }
  );

  return response.data.group;
}

async function getMattermostUserByEmail(email) {
  const normalizedEmail = email.trim().toLowerCase();

  console.log('Buscando usuário Mattermost pelo e-mail:', normalizedEmail);

  const response = await axios.get(
    `${MATTERMOST_URL}/api/v4/users/email/${encodeURIComponent(normalizedEmail)}`,
    { headers: mattermostHeaders }
  );

  console.log('Usuário encontrado no Mattermost:', {
    id: response.data.id,
    username: response.data.username,
    email: response.data.email,
    delete_at: response.data.delete_at,
    is_bot: response.data.is_bot
  });

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

async function getResponsibleTargets(issue) {
  const assignee = issue.assignee || issue.assigned_to;

  if (!assignee) {
    return [];
  }

  if (assignee.mail) {
    return [{
      type: 'user',
      name: assignee.name || assignee.login || assignee.mail,
      email: assignee.mail.trim().toLowerCase()
    }];
  }

  if (typeof assignee.id === 'string' && assignee.id.includes('@')) {
    return [{
      type: 'user',
      name: assignee.name || assignee.id,
      email: assignee.id.trim().toLowerCase()
    }];
  }

  if (!assignee.id) {
    return [];
  }

  try {
    const user = await getRedmineUser(assignee.id);

    if (user?.mail) {
      return [{
        type: 'user',
        name: `${user.firstname || ''} ${user.lastname || ''}`.trim() || user.login,
        email: user.mail.trim().toLowerCase()
      }];
    }
  } catch (errorUser) {
    console.log('Não localizou como usuário Redmine. Tentando como grupo.');
    console.log(errorUser.response?.status || errorUser.message);
  }

  try {
    const group = await getRedmineGroup(assignee.id);

    if (!group.users || group.users.length === 0) {
      return [{
        type: 'group_error',
        name: group.name || assignee.name,
        error: 'Grupo encontrado, mas sem usuários retornados pela API.'
      }];
    }

    const users = [];

    for (const groupUser of group.users) {
      try {
        const fullUser = await getRedmineUser(groupUser.id);

        if (fullUser?.mail) {
          users.push({
            type: 'group_user',
            groupName: group.name,
            name: `${fullUser.firstname || ''} ${fullUser.lastname || ''}`.trim() || fullUser.login,
            email: fullUser.mail.trim().toLowerCase()
          });
        } else {
          users.push({
            type: 'group_user_error',
            groupName: group.name,
            name: groupUser.name || groupUser.id,
            error: 'Usuário do grupo não possui e-mail na API do Redmine.'
          });
        }
      } catch (errorFullUser) {
        users.push({
          type: 'group_user_error',
          groupName: group.name,
          name: groupUser.name || groupUser.id,
          error: errorFullUser.response?.data || errorFullUser.message
        });
      }
    }

    return users;

  } catch (errorGroup) {
    return [{
      type: 'assignee_error',
      name: assignee.name || assignee.id,
      error: errorGroup.response?.data || errorGroup.message
    }];
  }
}

async function notifyMattermostUser(target, message, botUser) {
  const result = {
    email: target.email,
    name: target.name,
    type: target.type,
    success: false,
    stage: null,
    error: null
  };

  try {
    result.stage = 'buscar_usuario_mattermost';
    const mattermostUser = await getMattermostUserByEmail(target.email);

    if (mattermostUser.delete_at && mattermostUser.delete_at > 0) {
      result.stage = 'usuario_mattermost_desativado';
      result.error = 'Usuário Mattermost encontrado, mas está desativado.';
      return result;
    }

    result.stage = 'criar_dm';
    const directChannel = await createDirectChannel(
      botUser.id,
      mattermostUser.id
    );

    result.stage = 'enviar_mensagem';
    await sendMattermostMessage(directChannel.id, message);

    result.success = true;
    result.stage = 'entregue';

    return result;

  } catch (error) {
    result.error = error.response?.data || error.message;
    console.error('Falha ao notificar usuário:', result);
    return result;
  }
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

    const targets = await getResponsibleTargets(issue);

    if (!targets.length) {
      return res.status(200).json({
        message: 'Tarefa sem responsável ou sem e-mail.'
      });
    }

    const issueId = issue.id;
    const subject = issue.subject || 'Sem assunto';
    const status = issue.status?.name || issue.status || '';
    const priority = issue.priority?.name || issue.priority || '';
    const project = issue.project?.name || issue.project || '';
    const url = issue.url || `${REDMINE_URL}/issues/${issueId}`;

    const message = [
      `### Notificação do Redmine`,
      ``,
      `Você recebeu uma notificação da tarefa **#${issueId}**.`,
      ``,
      `**Ação:** ${action || 'Atualização'}`,
      project ? `**Projeto:** ${project}` : null,
      `**Assunto:** ${subject}`,
      status ? `**Status:** ${status}` : null,
      priority ? `**Prioridade:** ${priority}` : null,
      ``,
      `[Abrir tarefa no Redmine](${url})`
    ].filter(Boolean).join('\n');

    const botUser = await getMattermostBotUser();

    const results = [];

    for (const target of targets) {
      if (!target.email) {
        results.push({
          name: target.name,
          type: target.type,
          success: false,
          stage: 'sem_email',
          error: target.error || 'Responsável sem e-mail.'
        });

        continue;
      }

      const result = await notifyMattermostUser(target, message, botUser);
      results.push(result);
    }

    console.log('Resultado das notificações:');
    console.log(JSON.stringify(results, null, 2));

    const sent = results.filter(r => r.success);
    const failed = results.filter(r => !r.success);

    return res.status(200).json({
      message: 'Webhook processado.',
      issue: issueId,
      total: results.length,
      enviados: sent.length,
      falhas: failed.length,
      results
    });

  } catch (error) {
    console.error('Erro geral no webhook:');
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