# Atividade: retry automático para `fetch failed` no Sufficit AI

- Data: 2026-09-06 11:36 (America/Sao_Paulo)
- Escopo: adaptador OpenAI/Sufficit AI e ciclo de recuperação automática do Symposium
- Sintoma: a sessão mostrava `fetch failed` e o cartão `Automatic recovery was unavailable or exhausted`, sem entrar no retry automático.

## Diagnóstico

`TurnRunner.runTurn()` chamava `prepareTurnAccess()` antes da fronteira `try/catch`
que classificava falhas transitórias. Assim, uma rejeição de transporte durante
autenticação escapava da sessão sem emitir um evento `error` retryable. Além disso,
a descoberta automática de modelos descartava qualquer rejeição com `.catch(() =>
undefined)`, convertendo uma falha de rede em um diagnóstico de modelo ausente.

## Alterações

- `src/adapters/openai/turnRunner.ts`: colocou toda a preparação de acesso dentro da
  fronteira de captura do turno; `fetch failed` agora passa por
  `isTransientErrorMessage()` e chega ao `TransientRetryController`.
- `src/adapters/openai/turnAccess.ts`: falhas na descoberta de modelos agora são
  emitidas com `retryable` quando forem transitórias, sem transformar o erro em
  “nenhum modelo selecionado”.
- `src/test/turnRunnerLifecycle.test.ts`: adicionou regressões para falha de fetch
  durante autenticação e durante descoberta de modelos, verificando `retryable: true`
  e a emissão de `turn-end`.

O retry continua centralizado na política existente: contador, contagem regressiva,
limite configurado e cartão local da UI; a mensagem de estado não é enviada ao
agente nem cria uma nova bolha de usuário.

## Validação

- `npm run compile:test`: passou.
- `npm run test:unit`: passou — 736 testes.
- `npm run lint`: passou.
- `npm run typecheck`: passou.
- `npm run verify`: passou — release guardrail, Prettier, typecheck do webview,
  cobertura, checks de webview/configuração/tamanho/engenharia/arquitetura e bundle
  da extensão/PWA.
- `git diff --check`: passou.

Observação: uma execução manual com `node --test` sem o harness do projeto falhou
apenas por não carregar o módulo `vscode`; o runner oficial
`node --require ./test/register-vscode-stub.cjs --test ...` passou integralmente.
