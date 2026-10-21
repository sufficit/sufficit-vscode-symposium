# read_session para Claude, Codex e Copilot (troca de backend)

Pedido: ao trocar uma seção para o Claude, ele procurava a ferramenta `read_session` e respondia "tool absent". Opção escolhida pelo usuário: solução completa, sem deixar vestígios.

## Causa

`handoffReferenceNote()` e `sessionIdNote()` mandam qualquer backend chamar `read_session`, mas a ferramenta só existia no backend Sufficit AI (OpenAI). Os CLIs sobem apenas com `sufficit_ai`, `sufficit_identity` e `playwright`.

## Alterações e decisões

- Novo servidor MCP em memória (`src/adapters/localMcp/`): HTTP em `127.0.0.1`, porta efêmera, JSON-RPC (`initialize`, `ping`, `tools/list`, `tools/call`). Token aleatório por processo (comparação em tempo constante), recusa `Host` diferente do loopback e qualquer `Origin` (rebinding/navegador), POST apenas, corpo limitado a 1 MiB.
- Sem vestígios: nada é gravado para o servidor (sem script, sem cópia do transcript). O token vai pelo ambiente do processo (`SYMPOSIUM_LOCAL_MCP_TOKEN`); os arquivos de configuração guardam só `Bearer ${SYMPOSIUM_LOCAL_MCP_TOKEN}`. Codex recebe tudo por `-c` e nada entra em `~/.codex`. O servidor fecha no `deactivate`.
- `read_session` reutiliza o mesmo esquema e o mesmo leitor (`aiTools/readSession.ts`, extraído de `localRun.ts`) do backend Sufficit AI; sem `id`, lê a sessão que iniciou o CLI (cabeçalho `X-SYMPOSIUM-SESSION-ID`).
- Claude: `--mcp-config` + `--allowedTools=mcp__symposium__read_session`. Sem isso, o modo `acceptEdits` nega a ferramenta MCP (confirmado: DENIED).
- Copilot: o CLI 1.0.61 rejeita `--mcp-config` (`unexpected argument`); a flag correta é `--additional-mcp-config @arquivo`. Isso também corrige o carregamento do Playwright/`sufficit_ai` no Copilot, que dependia da flag inexistente.
- Um servidor do usuário chamado `symposium` não substitui o local.
- Prompt: as notas citam o nome real `mcp__symposium__read_session` e orientam a não adivinhar o pai pela memória caso a ferramenta falte.
- Orçamento do bundle host: 912 → 916 KiB (medido 937374 bytes = 915,40 KiB). Versão 2026.1021.1.

## Validação

- Testes novos: `localMcp.test.ts` (12) e `cliLocalMcpArgs.test.ts` (3, com um CLI falso que grava o argv); suíte completa 951/951.
- `npm run verify:package` passou: formatação, lint, tipos, cobertura, tamanho, arquitetura, VSIX (41 arquivos, 547500 bytes).
- Ponta a ponta com os CLIs reais contra o servidor real: Claude 2.1.303, Codex 0.163.0 e Copilot 1.0.61 chamaram `read_session` e receberam o texto, e o servidor registrou o id da sessão correta. `ClaudeSession` real em `acceptEdits` também funcionou, com HOME temporário. Recusas: sem token e token errado 401; `Host` forjado e `Origin` 403; GET 405; corpo > 1 MiB 413, servidor segue vivo.
- Os testes reais criaram sessões nos CLIs (`cwd=/tmp/lm-e2e`). Foram removidas por id exato: pastas do Claude, rollouts e linhas SQLite do Codex, pastas e linhas SQLite (incl. FTS) do Copilot; busca residual pelo canário voltou vazia.

## Pendente

Não publicado. As janelas abertas precisam instalar o VSIX e recarregar para ativar. O Genius CLI continua recebendo o histórico embutido (`geniusHandoffSeed`), como antes.
