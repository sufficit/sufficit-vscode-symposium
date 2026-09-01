# Release e publicação — guardrail obrigatório

Este projeto publica `sufficit.sufficit-vscode-symposium` no Visual Studio
Marketplace e no Open VSX. Toda alteração entregue deve seguir o mesmo fluxo:

`versão → verify:package → commit na develop → push → tag → instalação local/remota`.

O script `check:release` é executado dentro de `npm run verify` e garante que
`package.json`, `package-lock.json` e `VERSION.md` estejam sincronizados. No
fluxo estrito, ele também exige `develop`, rejeita versões não novas e valida
que a tag seja anotada e aponte para o commit publicado nessa branch. Em CI,
uma tag só passa quando seu nome é exatamente `v<package.json.version>`.

## Fluxo obrigatório

1. Confirme a branch e o estado do checkout:

   ```bash
   git switch develop
   RELEASE_GUARDRAIL_REQUIRE_DEVELOP=1 RELEASE_GUARDRAIL_REQUIRE_NEW_VERSION=1 npm run check:release
   ```

2. Atualize a versão CalVer sem criar commit/tag automático:

   ```bash
   npm version 2026.808.2 --no-git-tag-version
   ```

   Use `YYYY.MMDD.X`, sem zero à esquerda no segmento do mês/dia.

3. Valide e gere o artefato:

   ```bash
   npm run verify:package
   ```

4. Faça um único commit contendo todo o escopo da release e publique a branch:

   ```bash
   git add -A
   git commit -m "fix: describe the release"
   git push -u origin develop
   ```

5. Crie a tag anotada somente depois do push da `develop`:

   ```bash
   git tag -a v2026.808.2 -m "Release v2026.808.2"
   git push origin v2026.808.2
   ```

   Não mova nem sobrescreva uma tag publicada. O workflow de publicação valida
   que a tag aponta para um commit que está em `develop`.

6. Instale o VSIX validado nos ambientes de uso:

   ```bash
   code --install-extension ./sufficit-vscode-symposium-2026.808.2.vsix --force
   scp -P <porta> sufficit-vscode-symposium-2026.808.2.vsix <host>:/tmp/
   ssh -p <porta> <host> \
     'code-server --install-extension /tmp/sufficit-vscode-symposium-2026.808.2.vsix --force'
   ```

   No code-server de desenvolvimento, use o checkout/instalação em
   `/mnt/sufficit/sufficit-servers/development` e confirme a versão com:

   ```bash
   code-server --list-extensions --show-versions
   ```

7. Confirme a ativação da nova versão. Instalar o VSIX não substitui o código
   já carregado por janelas abertas: cada Extension Host mantém a versão que
   ativou até a janela ser recarregada. Execute `Symposium: Reload Window
   (apply latest build)` em cada janela afetada e confirme no log `Symposium`:

   ```text
   [extension] activated version=<versão-publicada>
   ```

   Em um code-server administrado, uma reinicialização remota só é válida após
   identificar a janela e o PID exato do seu `extensionHost`, confirmar que ela
   não possui turno em andamento e encerrar apenas esse PID. Nunca use `pkill -f`
   ou reinicie todos os hosts para aplicar uma extensão. A instalação só está
   concluída quando a versão listada e a versão ativada no log são iguais.

## Publicação automática

Ao receber `vX.Y.Z`, o workflow `Publish VS Code Extension` instala dependências,
executa o `verify`, empacota e valida o VSIX, publica no Visual Studio Marketplace
e no Open VSX e anexa o artefato ao GitHub Release.

O `workflow_dispatch` só deve ser usado para recuperar uma publicação da mesma
versão após falha operacional. Releases normais sempre seguem a sequência acima.

## Secrets necessários

No GitHub, configure:

- `VSCE_PAT`: Personal Access Token do Azure DevOps com escopo `Marketplace: Manage`.
- `OVSX_PAT`: token de publicação do Open VSX.
