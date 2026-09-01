# Auto-retry de rate limit no code-server

Status: **FINALIZED** (2026-09-01)

## Incidente

A sessão OpenAI/Suficit AI `286f40f5-7b57-47a8-ab39-bdcd562790eb`, intitulada
“fazer trim end das mensagens enviadas pelo channel quepasa”, falhou duas vezes
no code-server de development sem apresentar ou executar a recuperação
automática esperada.

## Causa

O VSIX `2026.901.4` estava instalado, mas a janela afetada continuava no
Extension Host PID `383598`, iniciado às 09:32, antes da instalação do pacote às
11:50. O processo carregado não é atualizado por `code-server
--install-extension`; a nova implementação somente passa a valer após a
reativação da janela.

O classificador atual já trata HTTP 429, `rate limit` e `too many requests` como
falhas transitórias. Portanto, o incidente não exigiu ampliar a lista de erros:
exigiu ativar a versão instalada e tornar essa etapa verificável.

## Correção

- O Extension Host afetado foi identificado, confirmado ocioso e encerrado
  isoladamente. O code-server o recriou como PID `766651`.
- A ativação agora registra `[extension] activated version=<version>` no canal
  Symposium. A evidência é emitida após a inicialização do `OutputChannel`, pois
  o code-server descartava o primeiro `appendLine` enquanto conectava o logger
  persistente.
- O procedimento de release passa a considerar instalação e ativação como
  verificações distintas; uma versão só está implantada quando ambas coincidem.
- Foi adicionado um teste que transforma uma resposta HTTP 429 do adaptador
  OpenAI em erro retryable e confirma o agendamento da tentativa `1/3` após um
  segundo, sem uma nova mensagem de usuário.

## Release

- alvo final: `v2026.901.6`
- `v2026.901.5`: correção funcional e primeira versão do guardrail
- `v2026.901.6`: emissão resiliente da evidência de versão no code-server
- feature de recuperação: `symposium.recovery` `1.1.0` (contrato inalterado)

## Verificação

- teste focal de auto-retry: aprovado
- `npm run verify:package`: aprovado
- release guardrail: aprovado para `v2026.901.6`
- VSIX: 41 arquivos, 507.384 bytes
