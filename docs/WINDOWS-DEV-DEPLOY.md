# Dev deploy & teste no VS Code do **Windows** (para agentes)

Guia para qualquer agente (Claude/Codex/Copilot) instalar e atualizar uma build
de desenvolvimento do Symposium na instância do **VS Code nativo do Windows**,
sem derrubar a sessão de chat que roda no host **WSL**.

> **Fonte do repo:** `~/projetos/docker/sufficit-vscode-symposium` (disco
> persistente). **Nunca** trabalhe a partir de `/tmp` — é volátil e some no
> reboot (já custou um WIP inteiro não-commitado). Mantenha o trabalho
> commitado e em branch.

## Por que Windows e não WSL
A sessão de chat do agente roda dentro da extensão no **host WSL**
(`~/.vscode-server/extensions`). Se você fizer deploy no WSL e a janela for
recarregada, **mata a própria conversa**. O VS Code **nativo do Windows** é uma
instância separada → reload lá não afeta o chat do WSL. Por isso o canal padrão
de teste é o Windows. (Há um fallback de WSL no fim deste doc, com ressalvas.)

> ⚠️ A extensão tem `main` e `extensionKind` indefinido → roda no lado
> **workspace**. Numa janela **Remote-WSL** o VS Code usa a cópia do WSL-server,
> **não** a do Windows. Para testar a build do Windows é preciso uma janela
> **LOCAL** do Windows (sem o badge "WSL" no canto inferior esquerdo).

## Caminhos (usuário Windows = `f_zhi`)
- Extensões instaladas: `/mnt/c/Users/f_zhi/.vscode/extensions/`
- Downloads (entrega do `.vsix`): `/mnt/c/Users/f_zhi/Downloads/`
- `/mnt/c` é acessível por subprocesso do bash (`cp`, `npm exec -- node -e ...`,
  `npx`). O `code` do Windows é dirigível por `cmd.exe /c "code ..."` (o aviso de
  caminho UNC é inofensivo) — dá pra **instalar** o `.vsix` automaticamente; só
  **não** dá pra forçar o reload por CLI (o usuário aperta 1 tecla — ver abaixo).

## Nomenclatura da build local (NÃO confundir com release do GitHub)
Para a build de desenvolvimento local usar uma identidade inconfundível:
- **`displayName`**: `Symposium (LOCAL DEV)` — aparece nas Extensões e no header do chat.
- **`version`**: major **`9999`** (ex.: `9999.625.1` → `9999.<mês.dia>.<build>`). O major
  `9999` garante que **nenhum release oficial do GitHub/Marketplace** seja considerado
  "mais novo" e sobrescreva a build local; e deixa óbvio que é dev, não release.
  A cada rebuild, suba o último número (`9999.625.2`, `.3`, ...).
- O `id` (`publisher.name = sufficit.sufficit-vscode-symposium`) é mantido, então a
  install atualiza no lugar. Esses campos são editados só na **cópia de build**
  (worktree `.wt-pkg`), **nunca** no `package.json` da árvore principal.

## Conceito-chave
**Copiar a pasta na mão em `.vscode/extensions` NÃO registra a extensão** — o VS
Code ignora (nem aparece na busca de Extensões). É preciso instalar via `.vsix`
**uma vez** (`code --install-extension`) para registrar. Depois disso, atualizar
é só sobrescrever a pasta `out/` da versão instalada + reload.

## 1) Instalação inicial (uma vez) — gera e instala o `.vsix`
A extensão usa `vsce`. NÃO edite o `package.json` da árvore: empacote a partir de
um **worktree isolado** no commit que você quer publicar, ajustando versão/nome só lá.

```bash
cd ~/projetos/docker/sufficit-vscode-symposium

# (a) worktree de packaging no HEAD atual (escondido do git status)
echo ".wt-pkg" >> .git/info/exclude
git worktree add .wt-pkg HEAD
ln -s ../node_modules .wt-pkg/node_modules          # reusa deps já instaladas

# (b) bump version + displayName SÓ na cópia
node -e 'const fs=require("fs"),p=".wt-pkg/package.json",j=JSON.parse(fs.readFileSync(p));j.version="9999.625.1";j.displayName="Symposium (LOCAL DEV)";fs.writeFileSync(p,JSON.stringify(j,null,2)+"\n")'

# (c) compila e empacota
cd .wt-pkg
npm run compile                                     # tsc -p + esbuild webview
npx --yes @vscode/vsce package --no-dependencies -o symposium-localdev-9999.625.1.vsix

# (d) entrega no Windows e instala (cmd.exe dirige o code do Windows)
cp symposium-localdev-9999.625.1.vsix /mnt/c/Users/f_zhi/Downloads/
cmd.exe /c "code --install-extension C:\Users\f_zhi\Downloads\symposium-localdev-9999.625.1.vsix --force"

# (e) limpa o worktree
cd .. && git worktree remove .wt-pkg --force
```
Depois: **Developer: Reload Window** na janela **local** do Windows (1 atalho — ver §3).
Confira com `cmd.exe /c "code --list-extensions --show-versions" | grep symposium`.

## 2) Loop rápido de atualização (sem reinstalar)
Depois da install inicial, NÃO reempacote/reinstale a cada mudança. Só:
1. Recompile o `out/` (na árvore principal mesmo: `npm run compile`).
2. Copie o `out/` por cima da pasta instalada (a de **maior versão**):
   ```bash
   npm exec -- node -e "const fs=require('fs');const d='/mnt/c/Users/f_zhi/.vscode/extensions/sufficit.sufficit-vscode-symposium-9999.625.1/out';fs.rmSync(d,{recursive:true,force:true});fs.cpSync('out',d,{recursive:true,force:true})"
   ```
3. Usuário dá **Reload Window** na janela local do Windows (1 atalho — ver §3).

O VS Code usa sempre a pasta de **maior versão**; mantenha o deploy nela.

## 3) Reload em 1 tecla (opcional)
Adicione em `keybindings.json` do Windows
(`/mnt/c/Users/f_zhi/AppData/Roaming/Code/User/keybindings.json`):
```json
{ "key": "ctrl+shift+r", "command": "workbench.action.reloadWindow" }
```

## Fallback: deploy no MESMO servidor WSL (com ressalvas)
Às vezes se quer a build rodando no próprio host WSL. Dois fatos importantes:

1. **`code --install-extension <vsix>` FALHA no WSL enquanto a extensão está
   ativa** (é ela que hospeda a sessão do agente). O install extrai a pasta mas o
   scan quebra com `ScanningExtension: Cannot read the extension ...` e **não
   registra** no `extensions.json` — o VS Code não troca uma extensão do mesmo
   `id` que está em execução naquele servidor. (No Windows funciona porque lá ela
   não está ativa no momento do scan.) Resultado: sobra uma pasta órfã; remova-a
   para não sujar o ambiente.
2. **Recarregar a janela WSL mata a sessão do agente** (reinicia o extension host
   que hospeda o chat).

Método que funciona = **overlay do `out/` na pasta já registrada** (mesmo da §2),
sem mexer no registro:
```bash
REG=~/.vscode-server/extensions/sufficit.sufficit-vscode-symposium-<versão-registrada>
cp -r "$REG/out" "$REG/out.bak"        # backup reversível
rm -rf "$REG/out" && cp -r out "$REG/out"
```
O **rótulo de versão não muda** (continua o da pasta registrada), mas o código é o
novo. Para ativar: **Reload Window** — e como isso encerra a conversa, recarregue
**outra** janela WSL do projeto, não a que hospeda o agente.

## Boas práticas
- Repo em disco persistente (`~/projetos/docker/...`); trabalho sempre commitado
  em branch. Nada de WIP só em `/tmp`.
- Empacote/iterar a partir de `git worktree` (`.wt-pkg`) ou diretório de build
  descartável — nunca alterando o `package.json` da árvore principal. Esconda
  dirs temporários em `.git/info/exclude` (`.wt-pkg/`, `.build-uni/`).
- Não há reload automático para extensões instaladas — o reload manual (1 tecla)
  é inevitável após mudança de código.
