# Agrupamento do thinking no Symposium

A captura do chat mostrava vários painéis “Pensando…” para uma sequência de raciocínio. O webview fechava o painel quando um fragmento continha apenas espaços ou quebras de linha.

- O painel existente agora acumula os fragmentos na ordem em que chegam e atualiza o contador de caracteres. O primeiro painel aparece assim que chega conteúdo visível.
- Texto, ferramentas, avisos do transcript e transições de turno encerram a sequência. Atualizações de uso podem chegar durante o thinking.
- A projeção AHP preserva a ordem entre raciocínio e os demais elementos da conversa. Ao carregar um snapshot, o webview reúne partes de raciocínio adjacentes e usa o último painel do turno ativo para acrescentar os próximos fragmentos.

## Validação e entrega

- Os testes de regressão reproduziram a fragmentação no webview e a perda de ordem no AHP antes da correção. Os testes finais também cobrem a seleção de texto e a retomada do painel após reconexão.
- `npm run verify` passou com Node.js 22, 1.088 testes, cobertura global e compilação da extensão, do webview e da PWA. A cobertura de linhas alteradas depende de `COVERAGE_BASE_SHA`, ausente na execução local.
- A entrega é o commit na `main`. A publicação da extensão segue o [procedimento de release](../maintainers/release.md).
