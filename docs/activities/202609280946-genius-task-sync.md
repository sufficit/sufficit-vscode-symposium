# Sincronização de tasks do Genius

Objetivo: fazer as tasks nativas criadas pelo Genius aparecerem no painel acima do compose.

Estado inicial: o CLI emitia `tasks_create`/`tasks_update`/`tasks_list` como tool calls, mas o parser do Symposium só criava linhas de ferramenta. O painel já aceitava snapshots normalizados `TodoWrite`.

Mudanças: `GeniusTaskTracker` converte resultados confirmados em snapshots ordenados; o parser emite atualização do painel separadamente, preservando a linha original da ferramenta. `tasks_update` e `tasks_list` substituem a projeção local pela lista completa; resultados inválidos/falhos são ignorados. O snapshot segue pelo fluxo de persistência e replay existente. O contrato e a limitação de sessões recém-descobertas estão documentados em `docs/GENIUS-CLI-ADAPTER.md`.

Decisões: usar o resultado do Genius, não a intenção do modelo, como autoridade; não adicionar chamadas ao modelo para sincronização. A UI reduz o estado `blocked` a pendente, pois seu tipo atual só oferece pendente/em andamento/concluído.

Validação: `npm run compile:test` passou; 28 testes focados passaram (Genius, restauração de tasks e projeção AHP); `npm run typecheck`, `npm run lint` e `git diff --check` passaram. `npm run compile` inicialmente falhou em TS2554 numa alteração local simultânea não relacionada em `src/adapters/toolSummary.ts`; não foi repetido após o conserto externo que permitiu `compile:test` e typecheck passarem.

Entrega: correção registrada em commit local próprio, após um commit simultâneo de refatoração de resumos de ferramentas. O plano temporário foi encerrado e substituído por este relatório. Sem push, release nem instalação nesta tarefa. Alterações locais preexistentes foram preservadas.
