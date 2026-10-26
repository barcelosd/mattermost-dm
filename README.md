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

## Q-Desk — distribuição de conversas

O endpoint `POST /qdesk/webhook` é independente das notificações `CHATWOOT_*`.
Consulta `GET /api/v1/accounts/15/conversations/{id}` e só transfere quando o
estado **atual** tiver `meta.team.id = 129` e um ID de grupo válido em
`meta.sender.company.group_company.id`, diferente de `175`. Campos ausentes,
nulos ou inválidos não causam transferência. O único body enviado a
`POST .../assignments` é `{"team_id":151}`.

### Variáveis no Render

```env
QDESK_ENABLED=false
QDESK_DRY_RUN=true
QDESK_URL=https://suporte.questor.com.br
QDESK_API_ACCESS_TOKEN=
QDESK_ACCOUNT_ID=15
QDESK_SOURCE_TEAM_ID=129
QDESK_GENERAL_GROUP_ID=175
QDESK_TARGET_TEAM_ID=151
QDESK_WEBHOOK_SECRET=
# Usar a conexão Redis já existente, se disponível:
REDIS_URL=redis://...
```

O token precisa consultar e atribuir conversas da conta configurada. O segredo
recebido pelo webhook é independente do token da API: gere um valor aleatório de
pelo menos 32 bytes, por exemplo com `openssl rand -hex 32`. Não publique esses
valores. Redis é obrigatório para esta integração; não há fallback em memória.
Configuração incompleta ou integração desabilitada responde `503`, sem afetar
as rotinas existentes. Apenas `QDESK_ENABLED=true` habilita o processamento.
Somente `QDESK_DRY_RUN=false` habilita POSTs; o padrão é simulação.

### Configurar e validar o webhook

1. Após publicação autorizada, configure as variáveis e mantenha
   `QDESK_DRY_RUN=true`. Ative `QDESK_ENABLED=true` para receber testes.
2. Na conta 15 do Q-Desk, procure **Configurações → Integrações → Webhooks**.
   Cadastre a URL pública real do serviço Render:
   `https://<dominio-do-servico>/qdesk/webhook?secret=<segredo>`.
   O parâmetro deve ser codificado como componente de URL. Se a instalação
   permitir cabeçalhos personalizados, prefira a URL sem query e
   `Authorization: Bearer <segredo>`.
3. Selecione `conversation_created` e `conversation_updated`, caso disponíveis.
   Não cadastre todos os eventos. Não foi confirmado suporte a assinatura HMAC
   na instalação Q-Desk 4.9.1; o módulo não presume esse suporte. A alternativa
   com segredo na URL depende somente do envio à URL cadastrada. Verifique no
   primeiro evento real se o Q-Desk preserva a query string.
4. Gere um evento real. O adaptador inicial aceita apenas eventos de conversa
   com `event` e ID de conversa em `id`. A conta vem de `QDESK_ACCOUNT_ID`,
   vinculada ao segredo autenticado deste endpoint. Use um segredo exclusivo
   para a conta 15. `account.id` e `account_id` são opcionais no evento;
   quando presentes, ambos precisam ser válidos e corresponder à conta configurada.
   A conversa é consultada exclusivamente na URL da conta configurada, com o
   token da integração. Seu ID e quaisquer IDs de conta retornados pela API
   são validados antes de avaliar a regra. Campos de mensagens ou contas
   aninhadas não são usados para escolher outra conta. Confirme os campos
   personalizados do fork Q-Desk no evento real. Formatos diferentes recebem `200 ignored` e geram diagnóstico
   `unsupported_event_shape`; não são convertidos automaticamente nem acionam
   a API. Nesses casos, ajuste o adaptador com base na estrutura real antes de
   habilitar transferências.
5. O diagnóstico registra somente tipos/presença de caminhos conhecidos, nunca
   conteúdo de mensagens, nomes, e-mails, tokens ou chaves arbitrárias do JSON.
   Para eventos reconhecidos, os logs contêm IDs técnicos de conta/conversa,
   time/grupo, evento, modo e decisão. Resposta da API fora do contrato
   (`id`, `meta.team.id`, `meta.sender.company.group_company.id`) não autoriza
   transferência; ID divergente gera falha, e metadados ausentes geram
   `missing_team_or_group`. Valide também esse retorno real.
6. Em simulação, confirme `would_transfer` para grupo diferente de 175 e time
   129; `no_change` para grupo 175 ou outro time. Não há POST em simulação.
   Somente depois da validação e autorização altere `QDESK_DRY_RUN=false`.

O módulo nunca registra a URL recebida. Porém, segredo em query pode aparecer
em logs do proxy/Render e na tela de configuração do Q-Desk: restrinja acesso e
configure ocultação da query nesses serviços; prefira Bearer quando disponível.
HTTPS é obrigatório para a API. Redirecionamentos da API são recusados para não
encaminhar credenciais a outro destino. O webhook limita JSON a 256 KiB e
valida autenticação antes de interpretar o corpo. Proteção adicional contra
volume abusivo pode ser configurada no proxy, conforme a infraestrutura real.

### Redis, repetição e falhas

Chaves usam exclusivamente `qdesk:`. Cada conversa possui bloqueio atômico
`SET NX EX` de 60 segundos, liberado via Lua somente pelo proprietário.
As chamadas à API têm timeout de 10 segundos cada; o bloqueio é revalidado antes
do POST. Eventos concluídos com time/grupo válidos são identificados pelo hash
SHA-256 do JSON recebido e deduplicados por 24 horas. O corpo não é salvo no
Redis. Simulação e execução real usam marcadores separados.

Falhas não marcam sucesso. Bloqueio ocupado, Redis indisponível, falhas de API
ou perda do bloqueio respondem `503`; autenticação inválida responde `401`,
JSON inválido `400`, tipo de conteúdo incorreto `415` e excesso de corpo `413`.
Eventos com conta explícita divergente/inválida ou desconhecidos respondem `200 ignored`.
Não há fila persistente neste módulo: confirme a política de reentrega do
Q-Desk. Se ele não repetir `503`, será necessário reenvio operacional ou uma
fila antes de exigir entrega garantida. Nunca se inicia trabalho em background
após responder sucesso.

Antes de qualquer nova tentativa, o estado é consultado outra vez. Assim, se
um POST tiver sido aplicado mas sua resposta se perder, a próxima consulta ao
time 151 evita repeti-lo. Eventos gerados pela própria atribuição também não
satisfazem a regra. Um novo evento pode reaplicar a regra se a conversa voltar
ao time 129. O hash identifica o evento completo; entregas semanticamente iguais
com JSON diferente podem gerar novas consultas, mas o estado atual protege
contra nova atribuição quando a conversa já está no destino.

O GET seguido de POST não é transação: uma alteração manual entre as duas
chamadas ainda pode disputar a atribuição. O bloqueio Redis coordena apenas
instâncias desta integração. Evicção/perda de Redis ou pausa do processo além
do prazo do bloqueio também impedem garantia absoluta de execução única.
Alterar somente o grupo no cadastro do cliente pode não emitir evento de
conversa; isso deve ser validado no Q-Desk.

### Testes

Execute `npm test`. Os testes Q-Desk iniciam apenas um servidor local em
`127.0.0.1` e usam API/Redis simulados, sem chamar o Q-Desk, enviar mensagens ou
inicializar `app.js`. Cobrem autenticação, parser, regra, consulta do estado,
simulação, POST real simulado, concorrência, deduplicação e falhas. A validação
com o Redis e os payloads reais de produção permanece uma etapa de homologação.

### Supressão de consultas repetidas

O hash dos eventos usa serialização estável: a ordem das chaves dos objetos
não muda a identidade do evento; a ordem dos arrays é preservada.

Após GET válido, estados com time fora da origem, grupo válido e `updated_at`
numérico positivo ficam no Redis por uma janela de até 2 segundos contada do
início da consulta. Consultas mais lentas que essa janela não criam cache.
O registro contém somente IDs de time/grupo, versão e horários técnicos.
Eventos repetidos não renovam a janela. A ordem observada pode ser atualizada,
mas conserva o instante inicial e usa somente o prazo restante.

A resposta `recent_confirmed_state` indica que o GET foi suprimido. Isso exige
metadados completos iguais ao estado confirmado, versão não anterior à versão
confirmada ou à última observada, e `changed_attributes` válido. A lista de
alterações pode estar vazia somente para a mesma versão confirmada. Alterações
de `status` ou `priority` podem ser reutilizadas se o delta incluir valores
anterior/atual e o valor atual corresponder ao campo do evento. Outros atributos
exigem GET por precaução, inclusive mudanças de time/grupo e campos desconhecidos.

Eventos novos indicando time 129 sempre consultam a API, assim como eventos
atrasados, inconsistentes ou incompletos. Reentregas de eventos idênticos já
concluídos continuam seguindo a deduplicação de 24 horas. Eventos apenas
suprimidos não recebem esse marcador: após a janela voltam a consultar.
O retorno 151 → 129 não é bloqueado pelo cache; nenhum POST usa estado em cache.
Antes de nova consulta, o cache anterior é invalidado, inclusive se a API falhar.
O bloqueio por conversa também protege a leitura e atualização desse cache.
Não foram acrescentadas variáveis de ambiente nem alterados os modos dry-run/real.

A otimização não garante detectar uma alteração cujo evento nunca seja entregue.
Um evento fora da origem compatível com estado recente pode ser suprimido antes
da chegada do evento de retorno; o evento de retorno deve ser entregue para
acionar imediatamente a avaliação. Sem dados/versionamento suficientes, o módulo
prefere consultar a API.
