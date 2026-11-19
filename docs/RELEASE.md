# Release e publicação do Symposium

O workflow **Publish VS Code Extension** publica
`sufficit.sufficit-vscode-symposium` no Visual Studio Marketplace e no Open
VSX. Ele também anexa o VSIX ao GitHub Release.

A integração das alterações acontece na `main`. Para publicar uma versão,
avance `develop` até o commit da release e crie uma tag anotada nesse commit.
O workflow verifica se a tag está na história de `origin/develop` e
corresponde à versão do pacote.

## Preparar a versão

1. Confira o estado do checkout e busque as tags existentes.

   ```bash
   git status --short --branch
   git fetch origin main develop --tags
   ```

2. Escolha uma versão superior à última tag conforme a
   [política CalVer](../VERSION.md). No exemplo abaixo, substitua o valor
   pela versão da release.

   ```bash
   version=2026.1119.3
   npm version "$version" --no-git-tag-version
   ```

   Atualize a data, o formato e a versão corrente em `VERSION.md`.
   Mantenha `package.json` e `package-lock.json` sincronizados.

3. Verifique a versão e valide o pacote local.

   ```bash
   RELEASE_GUARDRAIL_REQUIRE_NEW_VERSION=1 npm run check:release
   npm run verify:package
   ```

## Publicar pelo GitHub Actions

1. Revise e inclua apenas os arquivos da release. Faça o commit e envie-o à
   `main`.
2. Avance `develop` até o mesmo commit. O push sem `--force` rejeita
   divergências. Se houver divergência, resolva a integração antes de criar
   a tag.

   ```bash
   release_commit=$(git rev-parse HEAD)
   git push origin "${release_commit}:refs/heads/main"
   git push origin "${release_commit}:refs/heads/develop"
   ```

3. Crie e envie a tag anotada. Preserve tags já publicadas.

   ```bash
   git tag -a "v${version}" "$release_commit" -m "Release v${version}"
   git push origin "refs/tags/v${version}"
   ```

4. Acompanhe o workflow até confirmar a publicação nas duas lojas e o VSIX
   no GitHub Release.

O workflow instala dependências, roda `verify`, empacota o VSIX e valida seu
conteúdo antes de publicar. Use `workflow_dispatch` apenas para recuperar
uma publicação da mesma versão após falha operacional.

## Instalar e confirmar a ativação

Baixe o VSIX da release e use a CLI do ambiente onde a extensão vai rodar.

```bash
code --install-extension "sufficit-vscode-symposium-${version}.vsix" --force
code --list-extensions --show-versions
```

No code-server de desenvolvimento, use o ambiente registrado em
`/mnt/sufficit/sufficit-servers/development`. Transfira o VSIX para o host,
execute `code-server --install-extension <arquivo.vsix> --force` e confirme
a versão com `code-server --list-extensions --show-versions`.

As janelas abertas continuam com a versão que carregaram. Em cada janela
afetada, rode **Symposium: Reload Window (apply latest build)** e confira no
log **Symposium** a mesma versão listada na instalação.

```text
[extension] activated version=<versão-publicada>
```

Se o code-server exigir reinicialização remota, identifique a janela e o PID
exato do `extensionHost`. Confirme que a janela está sem turno em andamento e
encerre apenas esse PID. Evite `pkill -f` e reinicializações de todos os hosts.

## Segredos do GitHub Actions

- `VSCE_PAT` requer o escopo `Marketplace: Manage` do Azure DevOps.
- `OVSX_PAT` é o token de publicação do Open VSX.
