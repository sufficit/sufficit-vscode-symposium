# Correção de HTTP 403 ao concluir tarefas no Symposium

## Investigação

O histórico da sessão `3e2055cd-224d-4d1b-81e1-191bfb6921f2` registrou cinco respostas HTTP 403 para `task_complete` e `TaskUpdate`, entre 18h45 e 19h01 de 19/11/2026 (America/Sao_Paulo). Uma gravação `memory_save` bem-sucedida apareceu no histórico 62 ms antes de um desses 403. `add_task` e os dois aliases usam a mesma seleção de credencial e o mesmo `POST /api/memory/save`.

O hub exige `X-Symposium-Session-Id` ao ler e atualizar uma observação interna. A criação informa a sessão, mas a conclusão chamava a leitura e a gravação sem o cabeçalho. O hub podia omitir a tarefa da resposta de leitura e depois rejeitar a tentativa de atualização do ID existente. Os logs de `sufficit-ai.service` em Eveo, Apoint e Castrum entre 21h35 e 22h05 UTC não continham a rota nem o ID da sessão. A regra foi identificada no código do hub e reproduzida em teste com a mesma credencial na criação e na conclusão.

## Alterações

- A extensão envia a sessão atual ao buscar, concluir ou reabrir tarefas. A edição requer que a observação retornada pertença à sessão e mantém tipo, título, tags e expiração. Uma conclusão repetida preserva o resumo já salvo.
- A conclusão em cascata verifica as tarefas anteriores da sessão e respeita o marcador de tarefa solicitada pelo usuário. O painel usa a sessão na leitura por ID e na atualização da caixa de seleção.
- Ferramenta e painel explicam HTTP 403 como acesso negado à operação. HTTP 401 mantém a orientação sobre credenciais.

## Validação e entrega

- Antes da correção, o teste de regressão reproduziu o HTTP 403. Depois, passaram os 17 testes focados, incluindo os dois aliases, isolamento entre sessões e reabertura.
- `npm run verify` passou com 1.087 testes e compilação. A checagem de cobertura de linhas alteradas é condicional a `COVERAGE_BASE_SHA`, variável ausente na validação local. A cobertura global passou.
- A entrega é na `main`. O [fluxo de release](../maintainers/release.md) cobre a publicação e a instalação da extensão. A reprodução foi feita com um hub simulado e a sessão relatada permaneceu intacta.
