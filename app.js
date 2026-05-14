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
  MATTERMOST_TOKEN,
  POLLING_ENABLED = 'true',
  POLLING_INTERVAL_SECONDS = 60
} = process.env;

const mattermostHeaders = {
  Authorization: `Bearer ${MATTERMOST_TOKEN}`,
  'Content-Type': 'application/json'
};

const redmineHeaders = {
  'X-Redmine-API-Key': REDMINE_API_KEY,
  'Content-Type': 'application/json'
};

const issueAssigneeCache = new Map();

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

function getPayloadData(body) {
  const data = parseBody(body);

  if (data.payload && typeof data.payload === 'string') {
    try {
      return JSON.parse(data.payload);
    } catch {
      return data;
    }
  }

  if (data.payload && typeof data.payload === 'object') {
    return data.payload;
  }

  return data;
}

function getIssueFromPayload(body) {
  const data = getPayloadData(body);

  console.log('Payload convertido:');
  console.log(JSON.stringify(data, null, 2));

  return data.issue || data.webhook?.issue || null;
}

function getActionFromPayload(body) {
  const data = getPayloadData(body);
  return data.action || null;
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
    console.log('Buscando grupo Redmine:', groupId);

    const response = await axios.get(
      `${REDMINE_URL}/groups/${groupId}.json?include=users`,
      { headers: redmineHeaders }
    );

    console.log('Grupo encontrado:', response.data.group?.name);
    console.log('Usuários retornados no grupo:', response.data.group?.users?.length || 0);

    return response.data.group;

  } catch (error) {
    console.error('Erro ao buscar grupo Redmine:');
    console.error(error.response?.status);
    console.error(error.response?.data || error.message);
    return null;
  }
}

async function getMattermostBotUser() {
  const response = await axios.get(
    `${MATTERMOST_URL}/api/v4/users/me`,
    { headers: mattermostHeaders }
  );

  return response.data;
}

async function getMattermostUserByEmail(email) {
  const normalizedEmail = String(email).trim().toLowerCase();

  console.log('Buscando usuário Mattermost pelo e-mail:', normalizedEmail);

  const response = await axios.get(
    `${MATTERMOST_URL}/api/v4/users/email/${encodeURIComponent(normalizedEmail)}`,
    { headers: mattermostHeaders }
  );

  console.log('Usuário Mattermost encontrado:', {
    id: response.data.id,
    username: response.data.username,
    email: response.data.email,
    delete_at: response.data.delete_at
  });

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

  if (!assignee) return [];

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

  if (!assignee.id) return [];

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

  const group = await getRedmineGroup(assignee.id);

  if (!group) {
    return [{
      type: 'group_error',
      name: assignee.lastname || assignee.name || assignee.id,
      success: false,
      error: 'Grupo não encontrado na API do Redmine.'
    }];
  }

  if (!group.users || group.users.length === 0) {
    return [{
      type: 'group_error',
      name: group.name || assignee.lastname || assignee.id,
      success: false,
      error: 'Grupo encontrado, mas sem usuários retornados pela API.'
    }];
  }

  const targets = [];

  for (const groupUser of group.users) {
    try {
      const fullUser = await getRedmineUser(groupUser.id);

      if (fullUser?.mail) {
        targets.push({
          type: 'group_user',
          groupName: group.name,
          name: `${fullUser.firstname || ''} ${fullUser.lastname || ''}`.trim() || fullUser.login,
          email: fullUser.mail.trim().toLowerCase()
        });
      } else {
        targets.push({
          type: 'group_user_error',
          groupName: group.name,
          name: groupUser.name || groupUser.id,
          success: false,
          error: 'Usuário do grupo não possui e-mail no Redmine.'
        });
      }

    } catch (errorFullUser) {
      targets.push({
        type: 'group_user_error',
        groupName: group.name,
        name: groupUser.name || groupUser.id,
        success: false,
        error: errorFullUser.response?.data || errorFullUser.message
      });
    }
  }

  return targets;
}

function getAssigneeCacheKey(issue) {
  const assignee = issue.assignee || issue.assigned_to;

  if (!assignee) return 'sem_responsavel';

  return [
    assignee.id || '',
    assignee.mail || '',
    assignee.name || '',
    assignee.lastname || ''
  ].join('|');
}

function buildMessage(issue, action, source) {
  const issueId = issue.id;
  const subject = issue.subject || 'Sem assunto';
  const status = issue.status?.name || issue.status || '';
  const priority = issue.priority?.name || issue.priority || '';
  const project = issue.project?.name || issue.project || '';
  const url = issue.url || `${REDMINE_URL}/issues/${issueId}`;

  return [
    `### Notificação do Redmine`,
    ``,
    `Você recebeu uma notificação da tarefa **#${issueId}**.`,
    ``,
    `**Origem:** ${source}`,
    `**Ação:** ${action || 'Atualização'}`,
    project ? `**Projeto:** ${project}` : null,
    `**Assunto:** ${subject}`,
    status ? `**Status:** ${status}` : null,
    priority ? `**Prioridade:** ${priority}` : null,
    ``,
    `[Abrir tarefa no Redmine](${url})`
  ].filter(Boolean).join('\n');
}

async function notifyMattermostUser(target, message, botUser) {
  const result = {
    email: target.email,
    name: target.name,
    groupName: target.groupName || null,
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

    console.error('Falha ao notificar usuário:');
    console.error(JSON.stringify(result, null, 2));

    return result;
  }
}

async function processIssueNotification(issue, action, source, forceNotify = false) {
  const issueId = issue.id;
  const newAssigneeKey = getAssigneeCacheKey(issue);
  const oldAssigneeKey = issueAssigneeCache.get(issueId);

  if (!forceNotify && oldAssigneeKey === newAssigneeKey) {
    console.log(`Issue #${issueId} sem mudança de responsável. Não notificado.`);
    return {
      message: 'Sem mudança de responsável.',
      issue: issueId,
      notified: false
    };
  }

  issueAssigneeCache.set(issueId, newAssigneeKey);

  const targets = await getResponsibleTargets(issue);

  if (!targets.length) {
    return {
      message: 'Tarefa sem responsável ou sem e-mail.',
      issue: issueId,
      notified: false
    };
  }

  const message = buildMessage(issue, action, source);
  const botUser = await getMattermostBotUser();

  const results = [];

  for (const target of targets) {
    if (!target.email) {
      results.push({
        name: target.name,
        groupName: target.groupName || null,
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

  return {
    message: 'Processado.',
    issue: issueId,
    total: results.length,
    enviados: sent.length,
    falhas: failed.length,
    results
  };
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

    const result = await processIssueNotification(
      issue,
      action,
      'Webhook',
      true
    );

    return res.status(200).json(result);

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

async function fetchRecentIssues() {
  const response = await axios.get(
    `${REDMINE_URL}/issues.json`,
    {
      headers: redmineHeaders,
      params: {
        status_id: '*',
        sort: 'updated_on:desc',
        limit: 50
      }
    }
  );

  return response.data.issues || [];
}

async function pollingRedmineIssues() {
  console.log('Polling Redmine iniciado.');

  try {
    const issues = await fetchRecentIssues();

    console.log(`Polling encontrou ${issues.length} tarefas recentes.`);

    for (const issue of issues) {
      try {
        await processIssueNotification(
          {
            ...issue,
            url: `${REDMINE_URL}/issues/${issue.id}`
          },
          'Responsável alterado ou verificação periódica',
          'Polling',
          false
        );
      } catch (errorIssue) {
        console.error(`Erro no polling da issue #${issue.id}:`);
        console.error(errorIssue.response?.data || errorIssue.message);
      }
    }

  } catch (error) {
    console.error('Erro geral no polling Redmine:');
    console.error(error.response?.status);
    console.error(error.response?.data || error.message);
  }
}

app.get('/polling-now', async (req, res) => {
  await pollingRedmineIssues();
  res.json({ message: 'Polling executado manualmente.' });
});

app.get('/', (req, res) => {
  res.send('API Redmine → Mattermost funcionando.');
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);

  if (POLLING_ENABLED === 'true') {
    const intervalMs = Number(POLLING_INTERVAL_SECONDS) * 1000;

    console.log(`Polling habilitado a cada ${POLLING_INTERVAL_SECONDS} segundos.`);

    setTimeout(pollingRedmineIssues, 10000);
    setInterval(pollingRedmineIssues, intervalMs);
  }
});