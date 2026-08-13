# Plano — paridade de ferramenta de guardrail entre adaptadores

**Status:** Pendente
**Origem:** revisão de guardrails de 2026-08-13

## Objetivo

Fazer `add_guardrail`, `clear_guardrails` e leitura de guardrails terem o mesmo
contrato de ferramenta no OpenAI-compatible, Claude, Codex e Copilot, sem
duplicar regras de autorização nem deixar um CLI contornar o escopo da sessão.

## Escopo

1. Definir um contrato MCP único para guardrails, com `sessionId`, limite de
   tamanho, expiração e origem (`user-approved` ou `agent-requested`).
2. Conectar esse servidor aos quatro adaptadores somente quando houver token e
   origem autorizados; sem token, manter o fallback local já implementado.
3. Fazer todos os adaptadores reportarem a mesma capacidade no catálogo do
   Symposium, sem anunciar uma ferramenta ausente.
4. Aplicar aprovação para criação e remoção nos modos `manager` e `user`, e
   bloquear mutações em `plan`.
5. Adicionar testes de contrato por adaptador, isolamento entre sessões,
   expiração, falha do Hub/MCP, retry e reabertura em duas janelas.

## Critérios de aceite

- Um modelo nunca consegue gravar um guardrail em outra sessão.
- A ferramenta aparece somente quando pode ser executada pelo adaptador.
- A regra criada em uma janela chega à outra sem reiniciar o VS Code.
- Uma falha de MCP preserva o último cache e não apaga regras válidas.
- `npm test`, `npm run verify:package` e o smoke de autenticação passam.

## Fora deste plano

Corrigir o `appsettings.json` do `sufficit-identity` não pertence a este
repositório. A origem do code-server no CORS e os segredos/grants de ambiente
local devem ser tratados no projeto de identidade e em seus deploys.
