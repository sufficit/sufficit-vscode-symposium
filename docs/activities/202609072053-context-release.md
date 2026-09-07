# Release 2026.907.2 — contexto recuperável

Data: 2026-09-07, 20:53 (America/Sao_Paulo).
Sessão: `01a07de1-8dd7-7c91-a174-117288ca4298`.

O usuário autorizou integrar a entrega na main e publicar a release. A PR #53 foi
integrada em `42625a3`. Como a versão publicada vinha de develop, foi necessário
reunir as duas branches para preservar os recursos já entregues. O commit
`43e2f23` contém a base reunida e a versão 2026.907.2; main e develop receberam
esse commit antes da criação da tag anotada v2026.907.2.

Foram preservados recovery/voz da develop e Gemini/Antigravity/contexto da main.
Os contratos openai-compatible, ai-tools, configuration, compression e sessions
passaram a 1.1.0. O bundle reunido mede 837,2 KiB, dentro do teto explícito de
840 KiB; o teto independente de 1 MiB para o arquivo VSIX permanece.
Comentários condensados mantêm os arquivos dentro do limite de 400 linhas.

`npm run verify:package` passou com 762 testes, lint, formatação, typechecks,
guardrails e pacote validado. O guardrail estrito de release também passou.
O workflow [34168768786](https://github.com/sufficit/sufficit-vscode-symposium/actions/runs/34168768786)
publicou no Marketplace e no Open VSX e anexou o VSIX de 517.435 bytes à
[release 2026.907.2](https://github.com/sufficit/sufficit-vscode-symposium/releases/tag/v2026.907.2).
O catálogo público Open VSX confirmou a nova versão.

A atualização local solicitada nesta etapa era do Genius; não foi reiniciado o
Extension Host da conversa. O contrato da funcionalidade está em
[CONTEXT-HISTORY.md](../CONTEXT-HISTORY.md).
