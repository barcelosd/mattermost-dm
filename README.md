# Redmine — Mattermost e Chatwoot

Integração de alertas do Redmine com Mattermost, Chatwoot e WhatsApp.

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
