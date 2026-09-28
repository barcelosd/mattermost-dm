# Redmine — Mattermost e Chatwoot

Integração de alertas do Redmine com Mattermost, Chatwoot e WhatsApp.

## Chatwoot

O envio ao Chatwoot é adicional: ativá-lo não desativa nem modifica os envios ao
Mattermost. Os destinatários são localizados entre os agentes da conta pelo
e-mail, que deve ser igual ao e-mail do usuário no Redmine.

Crie uma caixa de entrada dedicada aos alertas, dê acesso aos destinatários e
configure:

```env
CHATWOOT_ENABLED=true
CHATWOOT_URL=https://chatwoot.exemplo.com
CHATWOOT_API_ACCESS_TOKEN=token_do_usuario_da_integracao
CHATWOOT_ACCOUNT_ID=1
CHATWOOT_INBOX_ID=25
```

No primeiro alerta, a integração cria automaticamente um contato técnico e uma
conversa individual atribuída ao agente encontrado pelo e-mail. Os próximos
alertas reutilizam essa conversa. Cada alerta é uma nota privada que menciona o
agente, gerando a notificação no Chatwoot. O token deve pertencer a um usuário
com acesso à conta e à caixa configuradas, e os agentes notificados precisam ter
acesso a essa caixa de entrada.

Com `CHATWOOT_ENABLED=false` (valor padrão), nenhuma chamada ao Chatwoot é feita.
