# Termos das buscas web do Codex

Uma busca real em sessão efêmera do Codex CLI 0.170.0 confirmou que `item.started` trazia `query: ""` e `action.type: "other"`. O evento `item.completed` com o mesmo ID trazia a consulta. O Symposium já havia criado a linha e descartava a descrição recebida na conclusão. [Teste equivalente no Codex](https://github.com/openai/codex/blob/main/codex-rs/exec/tests/event_processor_with_json_output.rs#L3030-L3157).

O adaptador agora preserva as consultas simples e em lote na conclusão. O webview atualiza a linha que já está visível e mantém seu estado de expansão. A projeção AHP e a reconstrução pelo histórico de eventos usam os mesmos termos. A descrição inicial permanece quando a conclusão não traz termos, e registros antigos que só guardaram o texto genérico continuam sem as consultas.

## Validação e entrega

- Os testes de regressão falharam antes da correção pela ausência de termos na conclusão projetada e pela permanência do texto genérico na linha. Depois da correção, passaram os testes focados de parser, projeção, histórico e DOM.
- `npm run verify` passou com 1.085 testes, incluindo formatação, lint, TypeScript, cobertura, verificações de arquitetura e compilação. Na primeira execução, a checagem Markdown apontou um link faltante para o plano temporário. O índice foi atualizado e a suíte passou.
- A entrega do código segue pela `main`. A publicação e a instalação da extensão seguem o [fluxo de release](../maintainers/release.md).
