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

## Q-Desk — distribuição secundária do grupo Geral

A rotina é criada pelo mesmo módulo `integrations/qdesk.js`, compartilha Redis,
token, configuração HTTP e chamada de transferência com o webhook. O webhook
continua aplicando sua regra original para grupos diferentes de 175.

Novas variáveis (não são configuradas automaticamente):

```env
QDESK_BACKFILL_ENABLED=false
QDESK_BACKFILL_DRY_RUN=true
QDESK_BACKFILL_INTERVAL_SECONDS=60
QDESK_BACKFILL_SOURCE_TEAM_ID=129
QDESK_BACKFILL_TARGET_TEAM_ID=151
QDESK_BACKFILL_GROUP_ID=175
```

Exige também `QDESK_ENABLED=true`, configuração Q-Desk válida e `REDIS_URL`.
Respeita exclusivamente `QDESK_BACKFILL_DRY_RUN`: em `true` (padrão), realiza consultas e validações e registra
`would_transfer`, sem POST nem reserva de movimentação. Em `false`, permite a
transferência somente quando o backfill foi explicitamente habilitado e
`QDESK_BACKFILL_DRY_RUN=false`. Valores inválidos bloqueiam a rotina.
`QDESK_DRY_RUN` continua controlando somente o webhook existente e não interfere
no backfill. É possível simular o backfill mantendo o webhook em execução real.

O primeiro ciclo ocorre após o intervalo configurado (padrão 60 segundos,
aceitos valores inteiros de 10 a 86400). Não existe endpoint público para
disparar essa rotina. Por padrão está desabilitada e não acessa API/Redis.

Cada ciclo valida duas vezes, antes e depois da seleção:

- Time de destino com `allow_auto_assign=true` e `max_assignment_limit` positivo.
- Expediente pelo `working_hours_enabled`, `timezone` e `working_hours` do time.
  O formato confirmado do Q-Desk usa `day_of_week` de 0/domingo a 6/sábado,
  `closed_all_day`, `open_all_day`, horas/minutos de abertura e fechamento e
  `break_start_hour`, `break_start_minutes`, `break_end_hour`, `break_end_minutes`.
  O intervalo 12:00–13:30 é fechado; 13:30 volta a permitir distribuição.
  Fechamento é exclusivo: às 18:00 o expediente 09:00–18:00 está encerrado.
  `working_hours_enabled=false` significa sem restrição de expediente.
  Campos ausentes, timezone inválida ou intervalo parcial/inválido bloqueiam.
- Integrantes: resposta como array, cada item com `id`, `active` booleano,
  `confirmed` booleano, `allow_auto_assign` booleano e `availability_status`.
  Somente ativos, confirmados, online e com distribuição automática contribuem.
  Este formato de integrantes ainda precisa ser confirmado no Q-Desk real;
  indicadores ausentes não são presumidos como verdadeiros.
- Métricas: array de objetos com `assignee_id` ou `team_id`, `open` e `unassigned`
  como inteiros não negativos. O endpoint padrão omite grupos sem conversas;
  ausência de linha em um array validado significa zero. Arrays/envelopes
  diferentes, duplicações e contadores incompletos bloqueiam o ciclo.
- Soma de capacidade `max(0, max_assignment_limit - open)` dos agentes elegíveis,
  usando métricas por agente de toda a conta; `unassigned` do time destino deve
  ser zero. Não há atribuição direta de agente.

A lista de origem usa paginação `page`, envelope `data.payload` e total em
`data.meta.unassigned_count`. Somente após obter todas as páginas, até o limite
conservador de 10, filtra conversas abertas, sem usuário/bot, time 129 e grupo
175. Totais inconsistentes ou paginação incompleta bloqueiam. Ordena por
`waiting_since` positivo, usando `created_at` positivo quando ausente/inválido;
empates usam ID. Sem timestamp válido, o ciclo bloqueia para preservar a ordem.
Revalida a conversa selecionada por GET, inclusive seu tempo de espera,
imediatamente antes da reserva/POST. Uma conversa atribuída, encerrada, movida
ou com grupo alterado não é transferida. Conversas já tentadas pelo backfill
não voltam a ser movimentadas por ele.

O máximo é uma transferência por ciclo. O POST usa somente `{"team_id":151}`;
o próprio Q-Desk decide o agente, conforme acesso à caixa e regras internas.
Depois do POST, um GET confirma destino e atribuição a um `User`.

### Reservas, falhas e recuperação

Há bloqueio Redis por destino (300 segundos) e o mesmo bloqueio por conversa
usado pelo webhook, com liberação Lua por proprietário e revalidação antes do
POST. Falhas de API/Redis e perda de bloqueio não autorizam envio. Não há fallback
em memória. O limite de páginas e timeout HTTP de 10 segundos limitam o ciclo.

Antes do POST, grava uma reserva persistente
`qdesk:<conta>:backfill:<destino>:pending` e um histórico
`qdesk:<conta>:backfill:moved:<conversa>`. Ambos não expiram automaticamente,
para impedir novos envios após reinício, timeout ou resposta perdida.
Cada ciclo reconcilia primeiro essa reserva. Enquanto não confirmar que a
conversa está no destino e atribuída a um usuário (ou resolvida no destino),
não envia outra. Mesmo após confirmar, encerra o ciclo; só o próximo pode
selecionar outra conversa. O histórico impede movimentar novamente a mesma
conversa se ela retornar à origem.

Uma tentativa cujo resultado permaneça incerto ou que tenha sido desviada
manualmente pode manter o backfill bloqueado. A recuperação exige revisão
operacional do estado real antes de remover reserva/histórico; não há limpeza
automática que arrisque repetir a transferência. Redis deve manter persistência
e evitar evicção dessas chaves. Perda desses dados remove a garantia de histórico.

Os logs `[qdesk-backfill]` incluem contagens de agentes elegíveis, capacidade,
fila do destino, candidatas, ID selecionado, modo, decisão e, em falhas, fase e
motivo interno. Contagens ainda não consultadas aparecem como `null`.
Não incluem nomes, mensagens, tokens, URLs recebidas ou objetos de erro externos.

APIs de leitura e atribuição não oferecem uma transação: agentes/automação do
Q-Desk ainda podem alterar fila ou conversa entre o último GET e o POST. Os
bloqueios coordenam instâncias deste serviço, não alterações externas.
Os testes automatizados simulam respostas e não ativam nem chamam produção.

## Q-Desk — conversas com roteamento já avaliado

O webhook mantém no Redis a chave
`qdesk:routing:processed:<conta>:<conversa>`. O registro contém somente versão
interna do formato, assinatura da regra/configuração/modo, IDs de time/grupo,
versão `updated_at`, última versão observada, hash do último evento avaliado
e prazo de expiração. Não contém
mensagens, nomes, e-mails, tokens ou o corpo do evento.

```env
QDESK_ROUTING_PROCESSED_TTL_DAYS=30
```

O padrão é 30 dias. Aceita inteiro de 1 a 3650; vazio, zero, decimal ou valor
inválido deixam o webhook indisponível, sem afetar a configuração do backfill.
Repetições não renovam o prazo original. A última versão observada pode ser
atualizada usando somente o TTL restante. Não existe cache local de marcadores.

Após autenticação e validação de evento/conta, o mesmo lock Redis atômico por
conversa protege leitura, invalidação e gravação. O marcador é consultado antes
da API. Um snapshot completo com time/grupo iguais, versão numérica não anterior
à confirmada/última observada e sem mudança relevante pode receber
`200 {"status":"already_processed"}`, sem GET nem log individual.
Campos ausentes, versões ausentes/antigas, JSON inválido no registro e mudanças
relevantes/desconhecidas levam à revalidação conservadora. Snapshot completo
pode ser comparado mesmo sem `changed_attributes`; quando presente, esse campo
precisa ser válido. São reconhecidos como irrelevantes: status, prioridade,
responsável, bot responsável, snooze, labels, waiting_since e primeira resposta.
Deltas incompletos ou contraditórios não autorizam reutilização.

Mudanças de time/grupo, modo dry-run/real ou assinatura da regra invalidam o
marcador com log `routing_invalidated`. A invalidação também remove o cache
curto e o hash daquele evento, para a deduplicação antiga não ocultar a correção.
Reentregas exatamente iguais já concluídas continuam deduplicadas, inclusive
quando o evento não contém todos os metadados necessários para comparar o
marcador. A expiração força nova avaliação em notificações subsequentes; ela
não dispara um job por si só. Sem entrega de evento relevante, não há garantia
de detectar uma mudança feita apenas no cadastro do cliente.

O marcador é criado para avaliação completa sem transferência, conversa no
destino correto ou transferência confirmada. Dados incompletos, falhas de API,
POST com erro e transferência sem confirmação não gravam sucesso. Em dry-run,
uma decisão `would_transfer` pode ser marcada como avaliada, mas a assinatura
inclui esse modo: uma simulação não dispensa o processamento real após troca
de modo. A regra de roteamento e os IDs continuam os mesmos.

### Confirmação de transferência do webhook

Antes de um POST real, grava uma reserva independente em
`qdesk:routing:pending:<conta>:<conversa>:live`. Depois do POST, faz GET e exige
ID/conta válidos, time de destino e grupo válido antes de marcar sucesso.
O webhook confirma o **time**, não espera atribuição de agente; o backfill tem
seu próprio controle de atribuição. Enquanto não confirmar, responde `202`
com `transfer_pending`, sem marcador de sucesso e sem repetir o POST.
Novas notificações consultam a conversa novamente. Um POST com erro/timeout ou
falha da consulta responde `503`. Timeout e falhas 5xx mantêm a reserva para evitar
envio duplicado; rejeições explícitas 400/401/403/404/405/413/415/422/429 liberam
a reserva para nova tentativa após corrigir a causa, sem marcar sucesso.
Se o estado continuar incerto ou tiver sido movido manualmente para outro time,
a revisão operacional é necessária antes de remover a reserva. Não há job
adicional de reconciliação: a tentativa seguinte depende de novo webhook/reenvio.

As chaves `qdesk:routing:*` não são usadas para selecionar nem bloquear candidatas
no backfill. Seu histórico e reservas permanecem em `qdesk:<conta>:backfill:*`.
Somente o lock por conversa é compartilhado para coordenar movimentações. Uma
conversa Geral avaliada pelo webhook continua elegível ao backfill.

### Resumo e redução dos logs

Um resumo é emitido a cada 60 segundos quando há contagens, com prefixo
`[qdesk-routing-summary]`: `received`, `alreadyProcessed`, `validated`,
`transfers` e `errors`. Os contadores ficam em um hash Redis por conta e modo;
incremento e expiração são atômicos via Lua. Cada hash expira em 5 minutos,
sem renovação por incrementos; isso remove resíduos mesmo após interrupção do
processo. A leitura e limpeza também são atômicas para coordenar múltiplas instâncias.
São contagens de eventos/avaliações, não de IDs únicos no período.
`received` conta requisições autenticadas que passaram pelo parser JSON.
`alreadyProcessed` conta notificações suprimidas pelo marcador (inclusive
reentregas idênticas associadas a ele). Eventos descartados só pelo hash antigo
podem não entrar nesse contador. `transfers` conta confirmação, inclusive se
ocorrer numa notificação posterior ao POST.

Primeiras avaliações, simulações, confirmações, invalidações e falhas continuam
com log individual. Eventos suprimidos pelo marcador ou cache curto não geram
log individual. Indisponibilidade de Redis impede transferências e gera log de
falha; se o Redis estiver indisponível, seus próprios contadores podem não ser
atualizados. Logs de falha não incluem objetos Axios nem mensagens externas.
A reentrega do último evento avaliado é reconhecida pelo hash estável salvo
no marcador, inclusive após uma transferência que mudou o time. Um novo evento
relevante continua invalidando a avaliação anterior.

O Redis precisa autorizar também `HINCRBY`, `HGETALL`, `TTL` e `EXPIRE`, além de GET/SET/DEL/EVAL.
