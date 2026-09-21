# Release v2026.921.1 — retry dispatch recovery

## Objetivo

Publicar a correção de retry silencioso em sessões restauradas do Sufficit AI
como `v2026.921.1`, com entrega no GitHub Releases, Visual Studio Marketplace e
Open VSX.

## Estado inicial

- `main`, `develop`, `origin/main` e `origin/develop` estavam em `ff79ad1`
  (`v2026.920.1`).
- A correção e seu relatório estavam validados localmente, ainda sem commit.
- A política CalVer determinou `2026.921.1` para 2026-09-21.

## Entrega

- Versão atualizada em `package.json`, `package-lock.json` e `VERSION.md`.
- Correção, regressões, metadados e relatório técnico consolidados no commit
  `b5c98e6951f844ca3837bb7d3fb3fcfe584b2a06`.
- `develop` publicado e `main` promovido por fast-forward para o mesmo commit.
- Tag anotada `v2026.921.1` criada a partir de `develop` e publicada.
- Workflow `Publish VS Code Extension` run `35604091570` concluído com sucesso
  em 1m57s.

## Validação

- `npm run verify:package`: passou integralmente.
- Guardrail diário/versionamento: passou para `v2026.921.1`.
- Guardrail com `RELEASE_GUARDRAIL_REQUIRE_DEVELOP=1`: passou em `develop`.
- VSIX local: 41 arquivos, 519.831 bytes, allowlist válida.
- GitHub Release publicado como release estável, com
  `sufficit-vscode-symposium-2026.921.1.vsix` (520.399 bytes).
- Open VSX expõe o registro versionado `2026.921.1` e seu arquivo de download.
- Visual Studio Marketplace entrega o endpoint versionado `2026.921.1` com
  HTTP 200 e 520.399 bytes. O alias público de catálogo oscilou temporariamente
  entre a versão anterior e a nova durante a propagação de cache.

## Referências entregues

- Release: <https://github.com/sufficit/sufficit-vscode-symposium/releases/tag/v2026.921.1>
- Workflow: <https://github.com/sufficit/sufficit-vscode-symposium/actions/runs/35604091570>
- Open VSX: <https://open-vsx.org/extension/sufficit/sufficit-vscode-symposium>
- Marketplace: <https://marketplace.visualstudio.com/items?itemName=sufficit.sufficit-vscode-symposium>

## Observação operacional

A release foi publicada sem recarregar o Extension Host local, evitando
interromper as sessões em execução. A ativação local da nova versão ocorre na
próxima atualização/recarga do VS Code.
