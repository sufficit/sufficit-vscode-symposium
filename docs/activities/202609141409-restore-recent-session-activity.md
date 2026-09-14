# Recuperação das atividades recentes ao reabrir sessões

**Data:** 2026-09-14 14:09 (America/Sao_Paulo)\
**Status:** implementação e validação concluídas; ativação na janela atual não
foi executada para não interromper sessões em andamento.

## Objetivo

Fazer sessões persistidas do Symposium reabrirem com as últimas atividades de
ferramenta e com o desfecho terminal na ordem correta, inclusive quando o turno
terminou sem uma resposta textual do assistente.

## Estado inicial e diagnóstico

A captura do usuário mostrava várias sessões com estado **Parou com um aviso**
ou **Precisa de atenção**, mas sem as ações imediatamente anteriores na conversa.
Os dados não haviam sido apagados: os `render.jsonl` append-only continuavam
íntegros.

Casos representativos encontrados no armazenamento local:

- `blazor-ui`: 111 conclusões de ferramenta no último turno e nenhum texto
  posterior, seguido do aviso terminal;
- `genius + plugins`: 73 conclusões no último turno textless, seguido do aviso;
- `identity - eval`: 14 conclusões e um erro terminal;
- `cloud mobile`: erro terminal preservado.

O guardrail encerrou chamadas repetidas/sem progresso como projetado. A falha
estava depois disso: `replayRows()` separava os blocos de texto ao encontrar
`tool-start`, porém não criava uma linha de histórico para a ferramenta. A
reprojeção AHP transitória substituía o snapshot detalhado por essa reconstrução
sem ferramentas. Em turnos sem resposta final, toda a atividade recente sumia e
restava apenas o aviso ou erro.

## Alterações entregues

### Reconstrução do render ledger

- Adicionado `controllerReplayTools.ts`, que correlaciona
  `tool-start`/`tool-output`/`tool-end` por `toolId`, preserva a ordem do início e
  recompõe nome, alvo, entrada, resultado, caminho, contagens, diff e tarefas.
- `replayRows()` agora inclui ferramentas emitidas diretamente e ferramentas
  já aninhadas em envelopes de histórico antigos.
- Um `tool-end` sem início disponível ainda gera uma linha recuperável.
- Placeholders vazios de `TodoWrite` continuam ocultos, como no renderer ao vivo.
- `controllerHistory.ts` passa essas linhas como `HistoryMessage.role = "tool"`
  em vez de descartá-las.

### Projeção e renderer AHP

- A projeção ao vivo e a projeção de histórico transportam também o diff da
  ferramenta em `_meta.symposium`.
- `toolDisplayMetadata()` valida e devolve os campos visuais aceitos pelo
  componente existente.
- O webview reusa `renderTool()` com caminho, adições/remoções, tarefas e diff;
  nenhuma nova identidade visual, token, componente ou regra de layout foi
  criada.

### Regressões

- Novo teste cobre um turno somente com ferramenta que termina em aviso e
  comprova a ordem `user -> tool -> status-notice`.
- Novo teste cobre o transporte AHP de caminho, contagens e diff.
- O harness DOM comprova a linha restaurada, alvo de arquivo, `+/-`, expansão do
  diff e resultado.
- As regressões anteriores de aviso terminal, erro recuperável, metadados de
  resposta, controller vivo e `TodoWrite` vazio continuam passando.

## Decisões e referências

| Decisão | Evidência | Resultado |
| --- | --- | --- |
| Não alterar o guardrail | Os logs mostram repetições reais sem progresso | Mantida a parada segura; corrigida apenas a perda visual |
| Reusar `HistoryMessage.role = "tool"` | Contrato e renderer AHP já existentes | Compatibilidade sem componente paralelo |
| Preservar o desenho atual | Captura do usuário, UI ao vivo e referência lock do Refero | Nenhuma mudança de cor, espaçamento, ícone ou hierarquia |
| Restaurar a atividade original | `render.jsonl` é a fonte durável do que foi exibido | Sem resumo ou texto sintético no lugar das ações |

O fluxo `refero-design` foi aplicado proporcionalmente como correção local: a
captura e a UI existente foram bloqueadas como referência, e o guia
`anti-ai-slop` reforçou a decisão de não redesenhar uma superfície que só
precisava recuperar seu estado real.

## Validação

- Regressão antes da correção: **FAIL** — linha de ferramenta ausente.
- 30 testes focados de transcript/history/AHP/surface: **PASS**.
- Diagnóstico sobre os ledgers reais: **PASS** — 111/73/14 linhas de ferramenta
  recuperadas nos três finais representativos, antes do aviso/erro correto.
- Harness DOM do webview: **PASS**.
- `npm run verify`: **PASS** — formatação, lint, tipos host/webview, suíte total,
  cobertura, webview/config script, tamanho, inventário de complexidade,
  engenharia, arquitetura, compilação e bundles.
- `npm run package:vsix && npm run check:vsix`: **PASS** — 41 arquivos,
  519727 bytes.
- VSIX: `sufficit-vscode-symposium-2026.914.1.vsix`.
- SHA-256:
  `853e8e97a68bb83906bf63edbc19fe275799d4be5a43486a8467d0e4691686d7`.

## Limites e ativação

O pacote mantém a versão de desenvolvimento `2026.914.1`; não houve bump,
commit, push, publicação ou instalação. A janela ativa também não foi
recarregada, porque existem sessões em execução e atividades anteriores que
explicitamente aguardam uma recarga segura. O código e o VSIX estão prontos,
mas a correção só aparece no cliente depois de uma instalação/release e recarga
autorizadas.
