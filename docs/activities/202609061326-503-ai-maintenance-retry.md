# Retry de manutenção 503 do Sufficit AI — 2026.906.3

## Sintoma

Durante uma atualização do Sufficit AI, a resposta 503 continha uma página
HTML de manutenção. O Symposium exibiu o erro técnico, mas uma falha recebida
no corpo do stream podia não ser classificada como transitória; nesse caso o
retry automático não era agendado.

## Causa

O classificador compartilhado reconhecia a linha `HTTP 503`, mas não o caso em
que o adaptador recebia apenas o corpo ou uma mensagem resumida com `503` e
`update`/`maintenance`. Esse formato é possível depois que o stream já foi
aberto.

## Correção

- Reconhecer `503` combinado com `update`, `updating` ou `maintenance` em
  qualquer ordem.
- Manter compatibilidade com as páginas antigas que usam `atualização` ou
  `manutenção`.
- Manter o retry como estado da UI: a mensagem de recuperação não é enviada ao
  agente como uma nova mensagem.
- Aumentar a extensão para `2026.906.3`.

## Validação

- Teste direcionado: 11 aprovados, 0 falhas, 0 cancelados.
- `npm run verify`: aprovado, incluindo lint, typecheck, testes, cobertura,
  guardrails e build.
- VSIX `2026.906.3`: allowlist e orçamento do bundle aprovados.
- Instalado no VS Code local e no code-server do CT 1021 (`code`), confirmado
  como `sufficit.sufficit-vscode-symposium@2026.906.3`.
