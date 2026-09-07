# Retry automático visível com countdown

Status: **FINALIZED** (2026-09-01)

## Problema

Falhas transitórias como `fetch failed` encerravam o turno sem retry quando já
havia atividade de ferramenta. O aviso anterior era estático e dizia que o
Symposium não tentaria novamente, sem mostrar tentativa, limite ou tempo
restante. Nos logs, a política era bloqueada por `visibleOutputStarted` mesmo
quando não existia resposta parcial do agente, somente eventos de ferramenta.

## Correção

- A recuperação agora diferencia resposta/raciocínio parcial de atividade de
  ferramenta. Texto, raciocínio e aprovação continuam bloqueando replay
  inseguro; uma queda após ferramentas pode retomar o mesmo intent.
- A retomada mantém `retryOf`, `intentId`, modelo, esforço e anexos, sem criar
  outra mensagem visível de usuário.
- O status de recuperação é uma ação operacional transitória, excluída do
  transcript, do `ChatState` AHP e do contexto enviado ao agente.
- Um único card é atualizado entre os estados agendado, executando, recuperado,
  cancelado e esgotado. Ele mostra tentativa X/Y, countdown ao vivo e o motivo
  conciso da falha.
- Uma ação manual cancela o timer e atualiza o mesmo card, impedindo disparo
  duplicado.
- O erro terminal agora informa corretamente que a recuperação automática ficou
  indisponível ou esgotou, em vez de afirmar que nunca existe auto-retry.
- O bundle webview passou a usar a otimização segura `minify-syntax` do esbuild,
  preservando nomes e sourcemaps de desenvolvimento e mantendo o VSIX dentro do
  orçamento de tamanho sem elevar o guardrail.

## Preferências

Em **Preferências → Comportamento do agente** permanecem o limite e a pausa
inicial, com a nova opção **Recuperar após atividade de ferramenta**. A chave
pública é `symposium.transientRetryAfterToolActivity`, ativada por padrão e
desativável para ferramentas que não sejam idempotentes.

## Versionamento

- `symposium.recovery`: `1.1.0`
- release: `v2026.901.4`

## Verificação

A suíte cobre backoff, limite, retomada após ferramenta, bloqueio após resposta
parcial, opt-out para ferramentas não idempotentes, cancelamento, recuperação,
esgotamento, exclusão do contexto do agente, projeção transitória AHP e card DOM
com contador e countdown. `npm run verify` passou integralmente.
