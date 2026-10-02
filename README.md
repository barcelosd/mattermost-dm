# Redmine — Mattermost e Chatwoot

Integração de alertas do Redmine com Mattermost, Chatwoot e WhatsApp.

## Mattermost

O Mattermost fica desativado por padrão. Para ativá-lo explicitamente:

```env
MATTERMOST_ENABLED=true
MATTERMOST_URL=https://mattermost.exemplo.com
MATTERMOST_TOKEN=token_do_bot
```

Com `MATTERMOST_ENABLED=false` (ou sem essa variável), nenhuma chamada ao
Mattermost é realizada. As confirmações e os lembretes enviados pelo WhatsApp
continuam funcionando de forma independente.

## Chatwoot

O envio ao Chatwoot é adicional: ativá-lo não desativa nem modifica os envios ao
Mattermost. Os destinatários são localizados entre os agentes da conta pelo
e-mail, que deve ser igual ao e-mail do usuário no Redmine.

Configure o usuário da integração:

```env
CHATWOOT_ENABLED=true
CHATWOOT_URL=https://chatwoot.exemplo.com
CHATWOOT_API_ACCESS_TOKEN=token_do_usuario_da_integracao
CHATWOOT_ACCOUNT_ID=1
```

No primeiro alerta para cada usuário, a integração cria ou recupera
automaticamente a conversa direta entre o usuário da integração e o agente
encontrado pelo e-mail. A mensagem aparece em **Chat interno > Direto** e os
próximos alertas reutilizam a mesma conversa. O token deve pertencer ao usuário
que será o remetente das notificações e ter acesso à conta configurada.

Não é necessário configurar caixa de entrada, contato nem ID de conversa.

Com `CHATWOOT_ENABLED=false` (valor padrão), nenhuma chamada ao Chatwoot é feita.

### O que é enviado ao Chatwoot

- Notificações de tarefas (Novo/Reaberta).
- Lembretes de compromissos em **Aguardando Data** (padrão: 10 e 2 minutos antes).
- Resumo de compromissos do próximo dia útil (padrão: 17h45, dias úteis).

Quando a tarefa está atribuída a um grupo do Redmine, os alertas de 10 e 2
minutos e o resumo do próximo dia útil são enviados individualmente a todos os
membros ativos com e-mail cadastrado. A integração precisa de acesso à consulta
do grupo e de seus usuários. Falhas nessas consultas mantêm o envio pendente
para nova tentativa e geram uma notificação de erro.

Cada entrega é registrada por canal e por destinatário. Se o Chatwoot falhar, a
próxima execução tenta de novo só o que faltou, sem repetir o Mattermost. O
resumo diário é tentado a cada minuto durante `DAILY_SUMMARY_RETRY_MINUTES`
(padrão 30) a partir de `DAILY_SUMMARY_HOUR:DAILY_SUMMARY_MINUTE`.

O ID da conversa direta de cada agente fica salvo no Redis. Se a criação da
conversa falhar porque ela já existe, a integração a localiza na lista de
conversas internas.

Diagnóstico: `GET /debug-chatwoot?email=usuario@empresa.com` mostra se o
Chatwoot está ativo, se o agente foi encontrado e qual conversa será usada.
