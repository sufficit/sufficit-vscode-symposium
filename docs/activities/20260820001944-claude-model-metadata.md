# Atividade — Modelo efetivo no cabeçalho das respostas Claude

> Data: 2026-08-20 00:19 (BRT)
> Status: concluída

## Sintoma

O cabeçalho das respostas Claude já mostrava o esforço e o horário correto,
mas continuava sem mostrar o modelo utilizado. O problema era mais evidente
no Code Server e nas sessões projetadas pelo AHP.

## Causa

O modelo podia ser anunciado pelo adaptador antes ou depois do primeiro bloco
de texto. A projeção AHP descartava esse estado entre eventos; quando o modelo
chegava pelo `usage`, ele atualizava o medidor, mas não o metadata da resposta
nem o cabeçalho já renderizado.

## Correções

- o estado da projeção AHP retém o modelo efetivo anunciado pelo Claude;
- deltas de texto usam esse modelo como fallback quando o evento de texto não o
  carrega;
- `chat/usage` preserva o mesmo modelo efetivo;
- a restauração de histórico usa o modelo do `usage` quando a parte markdown
  não possui metadata;
- a webview atualiza o chip do modelo quando ele chega depois da bolha;
- o evento de uso do parser Claude passa a carregar o modelo efetivo.

## Testes e validação

- regressão específica para modelo anunciado antes do texto;
- regressão para uso tardio do modelo no parser Claude;
- testes de cabeçalho da mensagem e projeção AHP;
- `npm test` aprovado, incluindo cobertura, webview, tamanho, complexidade,
  engenharia e arquitetura.

## Release

- versão: `2026.820.1`;
- branch: `develop`;
- artefato: `sufficit-vscode-symposium-2026.820.1.vsix`.
