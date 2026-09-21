# Release v2026.921.2 — visibilidade de atividade Codex/Astra

## Objetivo

Publicar a correção de visibilidade das atividades do adaptador Codex,
especialmente para o modelo Astra, como `v2026.921.2`, com entrega idêntica no
GitHub Releases, Visual Studio Marketplace e Open VSX.

## Estado inicial

- `develop`/`origin/develop` estavam em `e8bc27f`, com a correção e o ajuste de
  orçamento do bundle já aprovados no CI `35639744172`.
- `main`/`origin/main` estavam em `b736317`, correspondente à release anterior
  `v2026.921.1`.
- A política CalVer para 2026-09-21 determinou a próxima versão
  `2026.921.2`.

## Entrega

- Versão sincronizada em `package.json`, `package-lock.json` e `VERSION.md`.
- Commit de release
  `49ea348e21017a0e40c54dcb07df6e9d15faeb01` publicado em `develop`.
- `main` promovida por fast-forward ao mesmo commit.
- Tag anotada `v2026.921.2` criada a partir de `develop` e publicada no commit
  exato da release.
- Workflow `Publish VS Code Extension` run `35640740603` concluído com sucesso
  em 2min01s.

## Validação

- Guardrail de release com branch `develop` e versão nova: passou.
- `npm run verify:package`: passou integralmente; VSIX local com 41 arquivos e
  521.012 bytes, allowlist válida e bundle host de 843,8 KiB dentro do teto de
  848 KiB.
- GitHub Release publicado como release estável, com o artefato
  `sufficit-vscode-symposium-2026.921.2.vsix`.
- Open VSX expõe o registro versionado `2026.921.2`, publicado em
  `2026-09-21T18:49:57.091593Z`, e seu arquivo de download.
- Visual Studio Marketplace entrega o endpoint versionado `2026.921.2` com
  HTTP 200.
- Os três canais entregam o mesmo VSIX de 521.592 bytes, SHA-256
  `4ea59df647f6c7a0a4d3ea0d7730652ea1ef4df442c65cf61a7a1ee33fbc9036`.
- A API do Open VSX manteve brevemente um 404 em cache após a publicação; a
  consulta revalidada confirmou o registro e o download versionados.

## Referências entregues

- Release: <https://github.com/sufficit/sufficit-vscode-symposium/releases/tag/v2026.921.2>
- Workflow: <https://github.com/sufficit/sufficit-vscode-symposium/actions/runs/35640740603>
- Open VSX: <https://open-vsx.org/extension/sufficit/sufficit-vscode-symposium>
- Marketplace: <https://marketplace.visualstudio.com/items?itemName=sufficit.sufficit-vscode-symposium>

## Observação operacional

A release foi publicada sem recarregar o Extension Host local, evitando
interromper as sessões em execução. A ativação local da nova versão ocorre na
próxima atualização/recarga do VS Code.
