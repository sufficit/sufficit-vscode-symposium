# Acesso remoto ao Symposium (bridge + Tailscale)

Dirigir uma sessão de agente do celular, sem abrir porta no notebook. O
transporte é o **Tailscale** (WireGuard, direto, TLS no notebook); o bridge da
extensão continua em `127.0.0.1`.

> ⚠ **O bridge permite execução remota de agentes.** O comando AHP
> `createSession` pode subir um CLI. Só exponha atrás de um tailnet privado (ou
> de um túnel autenticado) e
> **com os limites de política abaixo configurados**. Um token vazado = shell na
> máquina.

## Política de segurança (configure ANTES de expor)

Estes controles ficam em `settings.json` (`symposium.bridge.*`). Um token válido
prova "um cliente conhecido chamou", não "a chamada é segura" — por isso os
endpoints perigosos têm limite próprio:

| Setting | Default | O que faz |
|---|---|---|
| `enabled` | `false` | liga o bridge |
| `token` | `""` (efêmero) | bearer exigido; defina um forte e estável |
| `allowedRoots` | `[]` → workspace | diretórios que uma sessão remota pode usar como `cwd`. Vazio = pastas do workspace aberto; sem workspace = criação remota recusada |
| `sessionPermission` | `acceptEdits` | modo de permissão forçado nas sessões remotas. `bypassPermissions`/`never` não são oferecidos |
| `allowedLmTools` | `[]` | ferramentas LM do VS Code invocáveis remotamente. Vazio = nenhuma (podem incluir terminal) |
| `allowExecutableOverride` | `false` | permitir reescrever o binário de spawn (é RCE limpo) |
| `allowVaultResolve` | `false` | permitir ler segredos do vault via `/vault/resolve` |
| `allowedHosts` | `[]` | valores aceitos no cabeçalho HTTP `Host` (anti DNS-rebinding), não endereços de bind. Loopback sempre passa; inclua o hostname/IP efetivamente usado pelo túnel ou proxy |

Exemplo mínimo seguro (troque os placeholders):

```jsonc
{
  "symposium.bridge.enabled": true,
  "symposium.bridge.pwa": true,
  "symposium.bridge.ahp": true,
  "symposium.bridge.token": "<TOKEN-FORTE-ALEATORIO>",
  "symposium.bridge.allowedRoots": ["<CAMINHO-ABSOLUTO-DO-PROJETO>"],
  "symposium.bridge.sessionPermission": "acceptEdits",
  "symposium.bridge.allowedHosts": ["<SEU-NODE>.<TAILNET>.ts.net"]
}
```

`allowedHosts` valida o cabeçalho HTTP `Host` que chega à Bridge. Por isso o
valor pode ser diferente de `symposium.bridge.host`: em proxy reverso, Docker,
Tailscale ou `ssh -R`, permita somente o hostname/IP interno usado na URL do
cliente. Porta é opcional; tanto `bridge.internal` quanto
`bridge.internal:47600` são aceitos quando o host corresponde. Não use `*` nem
uma lista ampla para contornar um `403`.

As alterações em `symposium.bridge.*` reiniciam a Bridge automaticamente. O
comando **Symposium: Restart Remote Bridge** permanece disponível para
recuperação manual; não é necessário recarregar toda a janela.

Gere um token forte:

```bash
node -e "console.log(require('crypto').randomUUID())"
```

## Fase 0 — provar que o celular alcança (sem escrever cliente)

1. **Ligar o bridge.** Aplique o `settings.json` acima; a Bridge reinicia
   automaticamente. No canal de saída "Symposium" deve aparecer `[bridge] listening on
   http://127.0.0.1:47600`.

2. **Expor pelo Tailscale** (o notebook disca pra fora; nenhuma porta inbound):

   ```bash
   tailscale serve --bg 47600
   # publica https://<SEU-NODE>.<TAILNET>.ts.net → 127.0.0.1:47600, TLS no notebook
   ```

   Veja o status e a URL:

   ```bash
   tailscale serve status
   ```

3. **Testar do celular** (com o app Tailscale ligado, no mesmo tailnet):

   ```
   GET https://<SEU-NODE>.<TAILNET>.ts.net/health
   Authorization: Bearer <TOKEN-FORTE>
   → { "ok": true, "version": "..." }
   ```

4. **Abrir a PWA AHP.** Acesse
   `https://<SEU-NODE>.<TAILNET>.ts.net/pwa/`, informe o token no login e
   confirme no canal de saída a conexão ao WebSocket `/ahp`.

O Bridge não expõe mais `GET/POST /sessions`, `/send`, `/interrupt` ou
`/follow`. Listagem, criação, envio, cancelamento e reconexão usam AHP. Tokens
em query string também são recusados; chamadas HTTP auxiliares usam
`Authorization: Bearer` ou `X-Symposium-Token`.

## Túnel SSH reverso

Mantenha a Bridge vinculada a `127.0.0.1` e encaminhe apenas pela rede privada.
Exemplo conceitual, executado na máquina que roda o VS Code:

```bash
ssh -N -R <IP-INTERNO-DO-HOST-SSH>:47600:127.0.0.1:47600 usuario@host-ssh
```

Se o agente chamar `http://<IP-INTERNO-DO-HOST-SSH>:47600`, configure:

```jsonc
{
  "symposium.bridge.host": "127.0.0.1",
  "symposium.bridge.allowedHosts": ["<IP-INTERNO-DO-HOST-SSH>"]
}
```

Valide primeiro `GET /health` e depois uma rota autenticada como
`GET /backends`. Um `403` com a mensagem `Host is not in
symposium.bridge.allowedHosts` significa que a requisição chegou à Bridge, mas
o `Host` recebido não está permitido; não indica token inválido. Consulte o
canal de saída **Symposium**, que registra o host recebido e a allowlist sem
registrar o token.

De um cliente local ou cujo host já seja permitido, o endpoint autenticado
`GET /bridge/diagnostics` mostra bind efetivo, política sem segredos e a última
recusa por host. Isso permite diagnosticar a chamada bloqueada sem expor token
ou ampliar temporariamente a allowlist.

Para uso contínuo, mantenha o token fora de arquivos versionados, faça o túnel
reiniciar automaticamente e monitore `/health` por dentro da rede privada.

## Verificação rápida dos limites

Com o bridge ligado, estas chamadas autenticadas devem ser **recusadas** pela
política padrão:

```
POST /vscode/lmtool       {name: "runInTerminal"}→ 403 lm tool not allowed
POST /backends/x/executable                       → 403 executable override disabled
GET  /vault/resolve?reference=...                 → 403 vault resolve disabled
```

Teste também pelo cliente AHP que `createSession` com `cwd: "/etc"` é
recusado quando `/etc` não pertence a `allowedRoots`.

## Próximas fases

- **PWA AHP** — implementada: o browser usa o cliente AHP, snapshots e ações
  ordenadas; não existe shim REST de chat.
- **Fase 2** — login Sufficit (client PKCE novo + validação de JWT no bridge),
  registro de máquinas no hub, Web Push no `turn-end`.

Ver o brief de arquitetura para o desenho completo e o plano por-arquivo.
