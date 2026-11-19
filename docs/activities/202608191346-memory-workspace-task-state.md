# Atividade — separar memória de alteração no workspace e reidratar tarefas

**Data:** 2026-08-19 13:46:16 -03:00
**Escopo:** sessões Symposium, especialmente o adaptador Claude e sessões compartilhadas no Code Server
**Status:** concluída

## Sintomas

- pedidos de alteração de arquivos podiam ser registrados em `memory_save` sem a correspondente escrita no workspace;
- a UI mostrava tarefas nativas restauradas ou recebidas de outra janela, mas o próximo prompt não conhecia esse estado;
- uma lista vazia de tarefas concluídas podia ser perdida durante a restauração, deixando o agente com um plano obsoleto.

## Alterações

- o prompt de saída agora declara, em todas as mensagens, que memória é apenas contexto e não substitui `read_file`, `edit_file` ou `write_file`;
- as descrições de `memory_save`, `write_file` e `edit_file` repetem essa fronteira para reduzir a ambiguidade no uso das ferramentas;
- o estado nativo de tarefas é reidratado do snapshot mais recente ao restaurar a sessão, carregar histórico ou receber uma atualização externa;
- snapshots vazios são tratados como autoritativos quando todas as tarefas foram concluídas;
- foram adicionados testes para envelopes de eventos, histórico restaurado, conclusão total e snapshots inválidos.

## Validação

- `npm test` — aprovado;
- `npm run compile:test` — aprovado;
- `npm run check:size` — aprovado;
- `git diff --check` — aprovado.

## Resultado esperado

Uma solicitação de mudança persistirá no disco antes de ser registrada como concluída, e o agente continuará recebendo o mesmo backlog que a UI apresenta mesmo após reabertura, sincronização entre janelas ou conclusão integral do plano.
