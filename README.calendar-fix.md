# Correção Google Calendar / Meet

Alterações:
- Usa `start_date` da API do Redmine como fonte da data exibida na tela como **Início**.
- Mantém compatibilidade com campo personalizado `Data` e `due_date`.
- Usa o campo personalizado `Horário` para montar data/hora.
- Só cria evento quando:
  - status = `MEET_STATUS_NAME` (ex.: Aguardando Data)
  - existe data de início
  - existe horário
  - existe tempo estimado maior que zero
  - campo `Google Meet` ainda está vazio
- Não grava a chave definitiva no Redis antes de criar o evento.
- Após criar o evento, salva o link do Meet no campo personalizado `Google Meet`.

Variável nova opcional:
```env
GOOGLE_MEET_FIELD_NAME="Google Meet"
```

Substitua o `app.js` pelo arquivo deste pacote.
