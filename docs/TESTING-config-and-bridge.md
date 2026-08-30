# Testing — Config UI, Public API e Remote Bridge (offline)

Tudo funciona **sem o sufficit-ai** (modo offline). O hub de sync ainda não está
ligado; estado de saúde aparece como `unknown`.

## 1. Build e instalar

```bash
npm run compile
# empacotar/instalar o .vsix como de costume, depois Reload Window
```

## 2. Tela de configuração

1. Abra a view **Symposium** → botão de engrenagem (**Configuração**) ou
   command palette: `Symposium: Configuration`.
2. Clique **Seed exemplos** (ou rode `Symposium: Seed Example Agents/Skills/Tools`).
   Cria recursos de exemplo em `~/.symposium/repo`.
3. Abas **Agentes/Skills/Tools/Instruções**: listam os recursos. Clique numa linha
   para abrir o arquivo; **✕** exclui; **+ Novo** cria.
4. Aba **Backends**: mostra disponibilidade dos CLIs (claude/codex/copilot).
5. Aba **Sync**: saúde do hub (`unknown` offline), último sync, pushes pendentes.
6. Editar um arquivo no `repo/` atualiza a lista ao vivo (watcher).

## 3. API pública (in-process)

De outra extensão / console de extension host:

```js
const sym = vscode.extensions.getExtension("sufficit.sufficit-vscode-symposium").exports;
sym.version;                       // "1.0.0"
sym.resources.seed();             // cria exemplos
sym.resources.scan();             // lista recursos
const id = sym.sessions.create("claude", { cwd: "/algum/projeto" });
sym.sessions.send(id, "olá");
const off = sym.sessions.follow(id, (m) => console.log(m)); // stream do chat
// off() para parar de seguir
```

## 4. Remote bridge (HTTP + AHP WebSocket)

Ligar nas settings:

```jsonc
"symposium.bridge.enabled": true,
"symposium.bridge.pwa": true,
"symposium.bridge.ahp": true,
"symposium.bridge.token": "meu-token",   // vazio gera token efêmero (vai no Output: Symposium)
"symposium.bridge.port": 47600
```

As settings `symposium.bridge.*` são reaplicadas automaticamente. O comando
`Symposium: Restart Remote Bridge` também pode ser usado para recuperação manual.

```bash
TOKEN=meu-token
BASE=http://127.0.0.1:47600

curl -s $BASE/health -H "Authorization: Bearer $TOKEN"
curl -s $BASE/resources -H "Authorization: Bearer $TOKEN"
curl -s -X POST $BASE/resources/seed -H "Authorization: Bearer $TOKEN"
curl -s $BASE/backends -H "Authorization: Bearer $TOKEN"
curl -s $BASE/bridge/diagnostics -H "Authorization: Bearer $TOKEN"

# abra a PWA e informe o mesmo token no login
xdg-open "$BASE/pwa/"
```

Chat remoto usa o WebSocket autenticado `GET /ahp` e os métodos AHP
`initialize`, `reconnect`, `listSessions`, `createSession`, `subscribe` e
`dispatchAction`. Endpoints HTTP auxiliares: `GET /health` ·
`GET/POST /resources` · `POST /resources/seed` ·
`DELETE /resources/:kind/:name` · `GET /backends` · `GET /sync` ·
`GET /bridge/diagnostics`. As antigas rotas HTTP/SSE de sessão devem responder
`404`; token em query string deve responder `401`.

## Segurança

- Bridge **off** por padrão. Bind `127.0.0.1`. Token obrigatório (401 sem ele).
- Exposição remota real só atrás de túnel autenticado — não expor a porta crua.
- O diagnóstico autenticado mostra configuração efetiva sem token e a última
  recusa por `allowedHosts`.
