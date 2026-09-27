# 2026-09-27 11:03 — finalização prematura em seção Kimi

## Objetivo e evidência inicial

Corrigir a seção `0416e9fb-4225-4de9-9671-eeeb934af33c` que parava após anunciar trabalho ainda não executado. O ledger mostra o backend OpenAI/Sufficit AI usando `k3-256k`, com requisições e respostas bem-sucedidas; os turnos 55–58 foram marcados “completed” sem erro de transporte. No turno 58, após duas ferramentas `shell`, a última resposta foi `Vou abri-lo:` (94 tokens) sem nova chamada; o controlador emitiu `turn-end`. A versão ativada naquele host era `2026.926.5`.

## Causa e mudança

O detector de resposta incompleta em `turnCompletion.ts` reconhecia “vou abrir”, mas não a forma pronominal “vou abri-lo”. Além disso, a continuação exigia ferramenta prévia no mesmo turno. Assim, um anúncio sem ação podia ser aceito como resposta final.

Uma resposta sem ferramenta terminada em dois-pontos agora é tratada como introdução incompleta, independentemente de já ter ocorrido ferramenta. O executor faz no máximo uma continuação, reutilizando os resultados existentes; se o modelo reincidir, mantém a pausa visível já prevista, sem laço. Nenhum arquivo do `sufficit-cloud-mobile` ou dado do WhatsApp foi alterado.

## Validação e entrega

- Teste dirigido `turnCompletion.test.ts`: 5/5 passaram, inclusive `Vou abri-lo:` após ferramenta sem reexecução, anúncio no primeiro hop e pausa após reincidência.
- `npm run verify:package`: passou na versão `2026.927.2`, com tipagem, lint, testes, cobertura, guardrails e VSIX validado.
- Versão de entrega: `2026.927.2` em `develop`, tag `v2026.927.2`; o VSIX é `sufficit-vscode-symposium-2026.927.2.vsix`.

## Limite

O detector é uma heurística para resposta incompleta, não uma garantia de que o modelo executará a ação na continuação. Depois de uma tentativa sem progresso, a seção fica explicitamente pausada para que o usuário escolha continuar. Janelas abertas precisam recarregar para ativar a versão instalada.
