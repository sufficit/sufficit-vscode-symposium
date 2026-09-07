# Retry automático da seção fleet — 2026.906.2

## Sintoma

A sessão `9fce7a9a-bf81-47de-b165-63b7467cfb80` (fleet) terminava com
`fetch failed`, embora o evento estivesse marcado como `retryable: true`. O
render log não continha o aviso de retry agendado nem o countdown. A sessão
ficava ativa por centenas de segundos e acabava exibindo somente o erro final.

## Causa

O turno e o transcript eram persistidos no render ledger, mas o estado do
`TransientRetryController` ficava apenas na memória do Extension Host. Quando
o host era substituído ou reanexado durante uma execução longa, o novo host
recebia o erro retryable sem a mensagem pendente e sem o controlador ativo.
Por isso o erro era exposto como fallback terminal, sem passar por
`recover()`.

Também havia uma fragilidade na leitura de preferências: valores serializados
como texto pelo code-server (`"true"`, `"2000"`) eram tratados como tipos
inválidos e voltavam silenciosamente ao comportamento padrão.

## Correção

- Reidratação do retry no recebimento de erro transitório, usando a última
  mensagem de usuário já persistida no transcript.
- Reenvio feito pelo adapter com a mesma intenção e histórico da sessão; a
  mensagem de retry continua sendo somente UI e não cria uma nova mensagem de
  usuário para o agente.
- Preservação dos marcadores duráveis de saída do assistente e atividade de
  ferramenta para manter as regras de segurança após a troca do host.
- Normalização de preferências numéricas e booleanas serializadas.
- Logs explícitos quando o retry é bloqueado, não possui erro deferido ou
  chega ao limite configurado.

## Validação

- `npm run typecheck`
- `npm run compile:test`
- testes focados: 25 aprovados, 0 falhas, 0 cancelados
- `npm run format:check`
- `npm run lint`
- `npm run typecheck:webview`

Release: `v2026.906.2`.
