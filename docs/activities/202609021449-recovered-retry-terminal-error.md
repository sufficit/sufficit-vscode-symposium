# Retry recuperado não deixa erro terminal obsoleto

Status: **FINALIZED** (2026-09-02)

## Incidente

Uma tentativa podia emitir `chat/error` por falha transitória, ser retomada por um
turno sintético e concluir normalmente. A resposta final ficava visível e a sessão
voltava ao estado ocioso, mas o turno anterior permanecia persistido como `error`.
Ao vivo ou após reabrir a conversa, a UI então mostrava um cartão vermelho depois
de uma resposta válida, contradizendo o estado real da sessão.

O caso foi confirmado na sessão `a6c77c19-d01e-4d83-bd26-8a31fb0e1c2e`: o erro
`fetch failed` ocorreu antes da retomada, e a tentativa seguinte terminou com uma
resposta final completa.

## Correção

- Um turno sintético iniciado logo após um erro é associado à tentativa anterior
  durante sua conclusão.
- Quando essa retomada conclui, o erro anterior é neutralizado sem apagar o texto
  parcial ou a resposta recuperada.
- A projeção de histórico também reconhece progresso posterior a um erro como
  evidência de recuperação.
- A webview associa cartões de erro ao turno e remove imediatamente o aviso
  obsoleto quando a retomada termina.
- Erros realmente terminais, sem progresso posterior, continuam preservados com
  a ação de retry correspondente.

## Versionamento

- extensão: `2026.902.2`
- `symposium.ahp`: `0.6.2`
- `symposium.chat-ui`: `1.1.2`

## Verificação

- testes direcionados da projeção histórica, reducer AHP e DOM aprovados;
- lint, formatação e typechecks do host e da webview aprovados;
- suíte integral: 720 testes aprovados, 0 falhas;
- limite estrutural de 400 linhas preservado;
- detector visual não identificou padrões novos nos arquivos alterados; os 14
  achados existentes em `chat.css` permanecem registrados como dívida separada;
- arquitetura: 464 módulos, 0 ciclos e 0 módulos inalcançáveis;
- VSIX: 41 arquivos, 509.821 bytes, allowlist aprovada.

## Release

- alvo: `v2026.902.2`
