# Atividade — Exibir modelo e esforço efetivamente usados nas mensagens

> Data: 2026-08-18 09:57 (BRT)  
> Status: concluída  
> Release: `v2026.818.3`

## Objetivo

Exibir no cabeçalho das mensagens do assistente o modelo e o esforço realmente
utilizados, tanto para mensagens transmitidas ao vivo quanto para mensagens
recarregadas do histórico. O mesmo metadado deve continuar disponível na
descoberta de sessões.

## Diagnóstico

O modelo era propagado de forma parcial e o esforço era descartado em vários
limites entre adaptador, histórico, eventos de streaming e webview. No Codex,
a descoberta de sessões também lia o esforço, mas não o incluía no objeto
retornado. Como consequência, a UI podia mostrar apenas o adaptador ou ficar
sem metadados, mesmo quando o CLI havia informado modelo e esforço.

Na validação ponta a ponta foi encontrado um segundo descarte: a restauração
preferencial pelo `render.jsonl` reconstruía somente texto e removia modelo e
esforço antes de montar o histórico enviado à webview.

## Implementação

- preservada a informação de modelo e esforço nos tipos de histórico e eventos;
- extraídos modelo e esforço dos transcripts Claude, Codex e Copilot;
- propagados os metadados nos eventos de texto e no streaming;
- renderizados `model: ...` e `effort: ...` no cabeçalho das mensagens do
  assistente, com traduções em inglês e português do Brasil;
- usado o esforço configurado como fallback somente para mensagens novas,
  sem inventar metadados em históricos que não os possuem;
- corrigida a perda do esforço na descoberta de sessões do Codex;
- preservados modelo e esforço na projeção do `render.jsonl` para histórico e
  handoff;
- aplicado fallback compatível para render logs antigos, usando o último modelo
  e esforço persistidos em `SessionInfo`;
- adicionados testes de parsing, propagação e renderização.

## Guardrails

- limite de 400 linhas por arquivo preservado;
- cobertura de modelo e esforço validada para histórico e streaming;
- validações de formatação, lint, tipos, arquitetura e engenharia executadas;
- detector visual executado; os avisos encontrados permanecem em estilos
  legados do `chat.css`, fora do bloco alterado.

## Validação

Validação completa aprovada com `npm run verify`, incluindo release guardrail,
formatação, lint, TypeScript, webview, testes unitários, cobertura, limite de
400 linhas, complexidade, engenharia, arquitetura e compilação dos bundles.

A publicação das versões anteriores foi verde, mas esta correção adicional
gera a release `v2026.818.3` para incluir a compatibilidade com render logs
antigos. A instalação local e no code-server será verificada pelo checksum do
VSIX desta revisão.
