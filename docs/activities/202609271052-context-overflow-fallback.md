# 2026-09-27 10:52 — recuperação de pedido acima da janela de contexto

## Objetivo e estado inicial

Evitar que uma sessão longa pare definitivamente quando a compactação automática não obtém um resumo. Na seção `4d4aeab6-8d9b-4256-91b2-bd12750fd56e`, turno 67, o pré-envio estimou 200.730 tokens para janela de 195.000 (802.917 caracteres, 194 mensagens e 26 ferramentas). A configuração local permitia 200 mensagens por pedido. O Symposium tentou a compactação de emergência, mas ela retornou sem resumo e o pedido não foi enviado. O motivo exato da ausência de resumo não foi registrado pelo sumarizador; no turno 68, a mesma seção conseguiu compactar 180 mensagens.

## Alterações e decisão

- Após falha da compactação de emergência, o executor reduz progressivamente o limite do histórico incluído **somente no pedido atual**, sem reescrever a sessão persistida ou o ledger. A mensagem de usuário mais recente continua fixada; o histórico omitido permanece recuperável por `read_session`.
- O pré-envio informa cada redução e só mantém o erro terminal se até o histórico mínimo não couber, como quando a própria mensagem atual é grande demais. A sequência de limites é finita, evitando laço de retentativas.
- Regressões cobrem a recuperação após falha do sumarizador, preservação da tarefa atual e do histórico salvo, convergência do limite inclusive com `maxHistoryMessages=0` e impossibilidade real de encaixar a mensagem atual.

## Validação

- `npm run verify`: passou (formatação, lint, tipagem, testes, cobertura, guardrails e bundle).
- `npm run verify:package`: passou na versão `2026.927.1`, incluindo a validação do VSIX `sufficit-vscode-symposium-2026.927.1.vsix`.
- O teste dirigido do executor e da política de contexto passou com o stub do VS Code.
- `git fetch origin develop --tags`: `develop` local e remoto alinhados antes da publicação.

## Entrega e limite conhecido

Versão de entrega: `2026.927.1` na branch `develop`, tag `v2026.927.1`. O sumarizador ainda não registra o status/erro específico da tentativa sem resposta nessa ocorrência histórica; a correção garante uma rota local de recuperação, mas não prova qual falha externa impediu aquele resumo. Se o prefixo obrigatório, as ferramentas e a mensagem atual sozinhos ultrapassarem a janela, o pedido continua recusado com diagnóstico em vez de ser enviado inválido.
