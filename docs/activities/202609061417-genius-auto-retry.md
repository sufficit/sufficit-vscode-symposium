# Retry automático da seção genius — 2026.906.4

## Sintoma

A seção `genius`, usando o backend Sufficit AI/OpenAI, terminava com `fetch
failed` e o cartão informava que a recuperação automática estava indisponível
ou esgotada. O evento já chegava classificado como `retryable: true`, mas o
retry não era armado em todos os caminhos.

## Diagnóstico

O controlador dependia do transcript renderizado para reconstruir a mensagem
original. Em uma falha durante o pre-dispatch, ou em uma continuação iniciada
por `continueTurn`, essa linha ainda podia não existir no stream. Sem uma
mensagem replayable, a reidratação do `TransientRetryController` não tinha como
agendar a próxima tentativa.

Também foi verificado o code-server do container 1021: o pacote `2026.906.3`
foi instalado às 16:31, mas o Extension Host estava carregado desde 07:01.
Instalar um VSIX não substitui módulos já carregados; a janela precisava ser
recarregada/reiniciada para executar a correção.

## Correção

- `Turn` mantém uma cópia isolada da `PendingMessage` que iniciou o turno.
- Dispatch normal e `continueTurn` registram esse snapshot antes de chamar o
  adapter.
- A admissão do retry consulta o snapshot do turno antes do histórico visual.
- Os anexos são copiados para evitar mutação da mensagem original.
- A mensagem de retry preserva a intenção, remove ids de envio e continua
  marcada como controle interno; não é emitida novamente como linha de usuário
  para o agente.

## Validação

- `npm run typecheck`
- `npm run lint`
- `npm run format:check`
- `npm test` — suíte contratual completa aprovada
- testes focados de turno, continuação, retry transitório e lifecycle — 40
  aprovados, 0 falhas
- `npm run check:size` — limite de 400 linhas aprovado
- `npm run check:engineering` e `npm run check:architecture` — aprovados

Release: `v2026.906.4`.
