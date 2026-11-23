# Release do painel de thinking

Objetivo: instalar a versão com o agrupamento de thinking no VS Code local e publicar a mesma versão pelo GitHub Actions. O código da correção está na `main` em `eb90dff`.

1. Concluído — CalVer `2026.1122.1`. O guardrail de versão e `npm run verify:package` passaram com 1.088 testes.
2. Concluído — VSIX com 45 arquivos e 562.704 bytes instalado. A CLI lista `2026.1122.1` e os três bundles instalados coincidem com o pacote. A janela ativa permaneceu aberta.
3. Concluído — commit `e948fb6` confirmado em `origin/main` e `origin/develop`, com a tag anotada `v2026.1122.1` publicada no mesmo commit.
4. Concluído — o workflow publicou nas duas lojas e anexou o VSIX ao GitHub Release. A API pública do Open VSX passou a listar a versão como baixável. O download foi validado com `check:vsix` e tem o mesmo SHA-256 do GitHub e do Marketplace. [Workflow](https://github.com/sufficit/sufficit-vscode-symposium/actions/runs/45078639636) · [GitHub Release](https://github.com/sufficit/sufficit-vscode-symposium/releases/tag/v2026.1122.1) · [API do Open VSX](https://open-vsx.org/api/sufficit/sufficit-vscode-symposium/2026.1122.1).

O VSIX oficial passou no `check:vsix` com 45 arquivos e 563.473 bytes. O arquivo do GitHub é idêntico ao download do Marketplace após a descompressão HTTP. SHA-256 dos dois arquivos `e76f36100425ee960eb6592ccb24f090f7110e39620ee2b97f920450128a2a92`. Os bundles da extensão, do webview e da PWA no VS Code local também são idênticos aos do VSIX oficial.
