# Encerramento prematuro de turno Sufficit AI — 2026-09-26 19:25 BRT

Objetivo: explicar e corrigir a parada da sessão `0416e9fb-4225-4de9-9671-eeeb934af33c`, após o assistente anunciar uma próxima medição sem executá-la.

Estado inicial: o ledger visual preservava o turno 52, seus resultados de ferramentas e um `turn-end` normal após 67.070 ms; a fila estava vazia. O último comando de consulta retornou código 1 porque não havia checker de integridade instalado no CT consultado. Nenhuma instalação ou cópia de estado do WhatsApp ocorreu nessa etapa.

Causa confirmada: os cinco dumps HTTP do Sufficit AI no nó `eveo-ai` mostraram quatro respostas com `finish_reason=tool_calls` e uma resposta final HTTP 200 com `response.completed`, `finish_reason=stop`, 81 tokens e nenhuma chamada de ferramenta. Não houve timeout, cancelamento nem falha de transporte. O adaptador do Symposium aceitava qualquer texto não vazio sem ferramentas como resposta final, mesmo quando o último parágrafo prometia uma ação concreta.

Correção: `src/adapters/openai/turnCompletion.ts` identifica uma promessa final de ação após atividade de ferramentas. O `TurnRunner` persiste a resposta e os resultados existentes, injeta orientação para retomar a tarefa sem repetir ferramentas e concede uma continuação no mesmo turno. Se o modelo repetir a promessa sem agir, o host encerra a tentativa com aviso terminal e ação Continue, evitando loop invisível. Três testes cobrem a frase observada, a continuação com resultado salvo e o limite de uma tentativa.

Validação: `npm run compile:test`, três testes focados, `npm run verify`, `npm run package:vsix`, `npm run check:vsix` e `git diff --check` passaram na base `2026.926.2`. A VSIX local tem 41 arquivos e 533.238 bytes. O primeiro empacotamento falhou por `ws@8.18.3` ausente na nova worktree; `npm ci` pelo lockfile resolveu a dependência. O CI do PR #71 passou, incluindo integração com o Extension Host.

Entrega: commit `fe153a5`, PR #71 mesclado em `develop` como `f944164`; tag anotada `v2026.926.2` aponta para esse merge. O workflow [36276053508](https://github.com/sufficit/sufficit-vscode-symposium/actions/runs/36276053508) passou e publicou no Visual Studio Marketplace e Open VSX. A [GitHub Release](https://github.com/sufficit/sufficit-vscode-symposium/releases/tag/v2026.926.2) contém a VSIX. O pacote local validado foi instalado no VS Code e no diretório de extensões do code-server; os bundles instalados e o pacote local têm SHA-256 `af4ea9b4f5b23538f5e31a8e373df22c1d032f93d2b45d9d8ec49f81290c95d9`.

Limites: o guardião detecta frases explícitas de próxima ação após uma ferramenta; não infere genericamente se qualquer tarefa foi concluída. A janela VS Code já aberta mantém o código carregado antes da instalação até ser recarregada; a ativação visual da correção na sessão afetada ainda depende desse recarregamento.
