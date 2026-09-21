# Atividade — fluxo de atividade do Codex/Astra

## Objetivo

Corrigir a pouca visibilidade do trabalho intermediário em sessões do adaptador
Codex, observada principalmente com o modelo Astra. A resposta final já era
correta, mas resumos de progresso, ferramentas, resultados, arquivos e duração
do turno não chegavam à interface com informação suficiente.

## Estado inicial e evidência

- O repositório estava limpo em `2026.921.1`, com `main` e `develop` no mesmo
  commit.
- A instalação local era Codex CLI 0.155.1.
- Uma captura controlada de `codex exec --json --model gpt-6-astra` confirmou:
  - comentários intermediários e resposta final chegam como `agent_message`;
  - `command_execution` concluído inclui `id`, `aggregated_output`, `exit_code`
    e `status`;
  - o parser descartava esses campos e não correlacionava início/fim.
- Ledgers reais do Astra continham dezenas ou centenas de ferramentas, mas zero
  eventos normalizados `thinking`, além de linhas pobres para MCP, busca e
  mudanças de arquivo.
- A documentação oficial do modo não interativo confirma os itens de mensagem,
  reasoning, comando, arquivo, MCP, busca e plano no JSONL:
  <https://learn.chatgpt.com/docs/non-interactive-mode>.

## Alterações

### Normalização de itens

- Criado `src/adapters/codex/itemParser.ts` para normalizar:
  - comandos com ID, saída limitada, código de saída e status;
  - chamadas MCP/dinâmicas com servidor, argumentos e resultado;
  - buscas web;
  - visualização de imagens;
  - chamadas de colaboração;
  - mudanças de arquivo com caminho e contagens de linhas adicionadas/removidas.
- Eventos concluídos sem um `item.started` observado sintetizam o início, para a
  interface nunca receber somente uma conclusão órfã.
- Versões antigas sem `item.id` continuam correlacionadas por uma chave estável,
  sem linha duplicada.

### Progresso, reasoning e resposta final

- O parser retém uma mensagem pública por vez porque o JSON do `codex exec` não
  carrega o campo `phase` do app-server.
- Uma mensagem seguida por ferramenta/atividade é emitida como `thinking`
  público; a última mensagem antes de `turn.completed` é a resposta `text`.
- Itens `reasoning` usam somente `text`/`summary` legíveis. O campo bruto
  `content` não é exposto, preservando o limite entre resumo público e raciocínio
  privado.
- Planos/todos também fecham a mensagem pendente como progresso antes de atualizar
  o painel.

### Tempo de execução

- `CodexSession` mede localmente o intervalo entre `turn-start` e `turn-end` e
  inclui `durationMs`; assim o rodapé do Symposium passa a mostrar o tempo mesmo
  quando o CLI não o fornece.
- Saídas de comandos seguem o mesmo teto de 6.000 caracteres dos demais
  adaptadores, evitando crescimento descontrolado do ledger.

## Decisões

- A correção ficou no limite do adaptador; a UI/AHP já renderizava corretamente
  `thinking`, ferramentas correlacionadas, resultados, caminhos e duração.
- Não foi feita migração para o Codex app-server. O `exec --json` continua sendo
  o transporte atual; a classificação progresso/final compensa com segurança a
  ausência de `phase` nesse formato.
- O Extension Host não foi recarregado automaticamente para não interromper
  sessões ativas.

## Validação

- Captura real controlada com Codex CLI 0.155.1 e `gpt-6-astra`: concluída.
- `npm run compile:test`: passou.
- Regressões focadas:
  `node --require ./test/register-vscode-stub.cjs --test out/test/codexEventParser.test.js out/test/codexSession.test.js`
  — 16/16 passaram.
- `npm run verify`: passou após a versão final da mudança, incluindo formatação,
  lint, typechecks, suíte completa/cobertura, validação da webview, limites de
  tamanho, inventário de complexidade, guardrails de engenharia/arquitetura e
  bundles.
- `git diff --check`: passou.

## Referências entregues

- `src/adapters/codex/eventParser.ts`
- `src/adapters/codex/itemParser.ts`
- `src/adapters/codex/session.ts`
- `src/test/codexEventParser.test.ts`
- `src/test/codexSession.test.ts`
- Branch de integração: `develop`.

## Limitações e próximos passos

- O Codex CLI não oferece raciocínio privado pelo `exec --json`; o Symposium só
  apresenta resumos e comentários explicitamente publicados pelo backend.
- A mudança precisa de nova versão/instalação e reload do Extension Host para
  entrar na instância local em execução. A publicação não fazia parte deste
  pedido.
