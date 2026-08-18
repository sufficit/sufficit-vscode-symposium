# Atividade — Exibir modelo e esforço efetivamente usados nas mensagens

> Data: 2026-08-18 09:57 (BRT)  
> Status: concluída  
> Release: `v2026.818.1`

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

## Implementação

- preservada a informação de modelo e esforço nos tipos de histórico e eventos;
- extraídos modelo e esforço dos transcripts Claude, Codex e Copilot;
- propagados os metadados nos eventos de texto e no streaming;
- renderizados `model: ...` e `effort: ...` no cabeçalho das mensagens do
  assistente, com traduções em inglês e português do Brasil;
- usado o esforço configurado como fallback somente para mensagens novas,
  sem inventar metadados em históricos que não os possuem;
- corrigida a perda do esforço na descoberta de sessões do Codex;
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

A publicação, instalação local e instalação no code-server são registradas no
handoff da release após a confirmação dos respectivos checksums.
