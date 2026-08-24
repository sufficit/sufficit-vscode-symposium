# Atividade — contraste do modo de permissões selecionado

**Data:** 2026-08-19 16:06:42 -03:00
**Escopo:** menu de configurações da webview do Symposium
**Status:** concluída

## Problema

O item ativo do menu de modos de permissões usava o fundo azul de seleção, mas
uma regra mais específica pintava o texto interno com `--vscode-focusBorder`,
que também era azul. O modo selecionado ficava praticamente ilegível.

## Correção

O texto do item ativo agora usa `--vscode-menu-selectionForeground`, com
fallback para `--vscode-list-activeSelectionForeground` e
`--vscode-foreground`. O check e a descrição continuam herdando o contraste
do menu, preservando os temas claro, escuro e alto contraste do VS Code.

## Validação

- `npm run typecheck:webview` — aprovado;
- `npm run build:webview` — aprovado;
- `npm run check:webview` — aprovado;
- detector visual executado; os alertas retornados são preexistentes e estão
  fora do seletor de modos de permissões.
