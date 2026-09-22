# Repetição de `read_file` no Sufficit AI — 2026-09-22 18:17 BRT

## Incidente

A seção `16e44773-fa9a-43da-814f-b9ba0efdb3ef` continuava parando depois
da recuperação introduzida em `75b9644`. O último request registrado
(`turn-16/attempt-8`) continha os resultados completos de leituras anteriores
e nove avisos do guardrail, mas ainda anunciava `read_file` entre 26
ferramentas com `tool_choice: auto`. O modelo voltou a escolher a mesma
leitura; duas tentativas textuais de recuperação não mudaram o comportamento.

## Alteração

- Após uma chamada duplicada ser ignorada, o próximo request omite o nome
  exato da ferramenta repetida. As demais ferramentas continuam disponíveis;
  a exclusão termina assim que o modelo executa uma ação diferente.
- Ao retomar um turno após o guardrail com `continue`, a exclusão inicial é
  recuperada pelo fingerprint da última chamada correspondente no histórico.
- Quando a allowlist/exclusão deixa zero ferramentas, o request envia
  `tool_choice: none`. Isso impede que o adaptador Codex do gateway reofereça
  ferramentas reconstruídas a partir do histórico nesse caso.
- O histórico e os arquivos da seção não foram modificados pela correção.

## Verificação

- Novos testes de integração com SSE Responses cobrem recuperação no mesmo
  turno, retomada após `continue` e allowlist sem ferramentas restantes.
- `npm run verify` e `npm run verify:package` passaram, incluindo suíte,
  cobertura, lint, typecheck, validações de arquitetura/tamanho, bundle e
  `check:vsix` (41 arquivos; 526.970 bytes).
- VSIX local SHA-256:
  `59eae83fdae0c4ab6a6db4102e3b37909801f69b98f51f4b3da428ab09519054`.
- Guardrail estrito da release aprovou `v2026.922.1` em `develop`.

## Limite da validação

A regressão confirma o contrato enviado pelo Symposium, sem depender de uma
resposta específica do modelo. A seção real só poderá confirmar o desfecho
após a nova versão estar ativa na janela e receber um novo `continue`.
