# Activity — recuperação do histórico Claude ao reabrir sessão viva

**Status:** Concluída
**Data:** 2026-08-14

## Problema observado

A sessão Claude `418222dc-9878-4819-8001-e815b9f0458e` permanecia no runtime
local, mas era reaberta com o transcript vazio. O arquivo nativo do Claude e o
ledger do Symposium continuavam íntegros no disco.

## Diagnóstico

- O transcript nativo continha 84 registros e 436.772 bytes.
- O render ledger continha 146 eventos e 171.550 bytes.
- A reconstrução do ledger produzia 10 linhas visíveis de conversa.
- O snapshot AHP associado à sessão principal continha zero turnos.
- Ao encontrar um controller ainda vivo, `SurfaceDialogues` encerrava
  `historyPending` imediatamente e confiava que o snapshot AHP já continha o
  histórico. Essa suposição deixou a tela vazia quando o snapshot estava
  ausente ou defasado.

## Implementação

- A reabertura de uma sessão agora reprojeta o histórico autoritativo mesmo
  quando reutiliza um controller vivo.
- Quando o stream já está restaurado, a página de histórico é enviada como
  notificação transitória aos observadores AHP, sem ser anexada novamente ao
  render ledger.
- O carregamento inicial sem ledger mantém o comportamento persistente
  existente.
- O stub de VS Code passou a modelar `window.tabGroups`, permitindo exercitar
  o fluxo real de abertura em teste unitário.

## Testes e validação

- Regressão: reabrir controller vivo chama `loadHistory` em modo transitório e
  só encerra o overlay após a projeção.
- Regressão: histórico transitório alcança o observador AHP, mas não entra no
  stream persistido.
- Testes focados de histórico e projeção AHP passaram.
- `npm test`: suíte completa, cobertura e guardrails de webview, configuração,
  tamanho, complexidade, engenharia e arquitetura passaram.

## Release

O pacote de release é `v2026.814.1`; ele segue o guardrail de
`verify:package`, commit na `develop`, push, tag anotada, CI e instalação do
VSIX no VS Code local e no code-server de desenvolvimento.
