# Correção: tarefa atribuída a grupo do Redmine

Esta versão altera o envio de DM no Mattermost para tratar responsáveis que sejam grupos do Redmine.

## O que mudou

- Quando `issue.assigned_to.id` for um grupo, o app busca os membros do grupo no Redmine.
- Para cada membro, busca o e-mail do usuário no Redmine.
- Envia DM individual no Mattermost usando o e-mail.
- Mantém fallback para usuário individual quando o responsável não for grupo.
- Cache Redis:
  - e-mail de usuário: 24h
  - lista de e-mails do grupo: 15min

## Observação importante

Para listar membros de grupos e/ou consultar e-mails dos usuários, a `REDMINE_API_KEY` precisa ter permissão suficiente no Redmine.
O app tenta primeiro:

`GET /users.json?group_id=<ID>`

e, se não conseguir, tenta:

`GET /groups/<ID>.json?include=users`
`GET /users/<USER_ID>.json`

## Instalação

Substitua seu `app.js` pelo arquivo `app.js` deste ZIP e reinicie a aplicação.

## Validação

A sintaxe foi validada com:

`node --check app.js`
