# PLAN — Indicador working/idle para sessões em modo `follow` (plugin Claude)

> Status: **planejado** (fazer depois). Mudança aditiva, sem regressão.
> Repo: `sufficit-vscode-symposium`

## Problema

Sessões espelhadas via `adapter.follow()` — um agente Claude rodando em **outro
processo** (ex.: terminal interativo) que o Symposium apenas acompanha em
read-only — **não exibem o indicador de estado `working`/`idle`**. O histórico
sincroniza corretamente, mas falta o sinal visual de "o agente está trabalhando".

### Por que falta hoje

O fluxo do indicador é:

```
UI (chatClient ~l.1578)  ──lê──>  sessions.status(id)
                                       └─> LiveSessions.statusFor(id)
                                              └─> findBySessionId → ChatController.isBusy
```

- O status **só existe quando há um `ChatController` local** registrado em
  `LiveSessions`.
- Na sessão seguida **não há controller** (o processo é de outra instância),
  então `statusFor()` retorna `undefined` e a UI não pinta nem `working` nem
  `idle`.
- O `follow()` (em `src/adapters/claude.ts`) só faz **tail do JSONL** e emite
  `HistoryMessage`. Não tem nenhuma noção de turno — diferente do `ClaudeSession`,
  que rastreia `turnActive` e o limpa ao ver a linha `result`.
- Pior: `parseTranscriptLine()` **descarta a linha `type:"result"`** (e converte
  `user`/`assistant` em texto), de modo que o sinal de "fim de turno" se perde
  antes de chegar a qualquer consumidor.

## Solução — inferir o estado a partir do próprio transcript

Como não há processo nosso para consultar `isBusy`, inferimos pelo JSONL que já
estamos seguindo. O **Claude Code grava uma linha `type:"result"` ao concluir
cada turno** — é o mesmo sinal que o `ClaudeSession` usa no `turnActive`, logo é
confiável.

### Heurística

- linha `user` / `assistant` / `tool_use` chega → **working**
- linha `result` chega → **idle**
- inatividade > ~8–10 s após a última linha não-`result` → **idle** (fallback,
  cobre o caso de o `result` não ter sido gravado, ex.: crash/kill)
- disparar o callback **somente em transição** de estado (evita ruído)

> É uma **inferência**, não verdade absoluta. O fallback por inatividade garante
> que a sessão acabe marcada como `idle` se o `result` nunca chegar.

## Edições (4 pontos, aditivas)

### 1. `src/adapters/types.ts` — estender o contrato do follow

```ts
export interface FollowHandle {
    dispose(): void;
    /** Optional: fires "working"/"idle" inferred from the followed transcript. */
    onStatus?(cb: (status: "working" | "idle") => void): void;
}
```

### 2. `src/adapters/claude.ts` `follow()` — rastrear o tipo cru da linha

No loop do `drain`, **antes** de `parseTranscriptLine(line)`, inspecionar o
`type` bruto:

```ts
for (const line of lines) {
    const t = rawType(line);              // JSON.parse → entry.type
    if (t === "result") setStatus("idle");
    else if (t === "user" || t === "assistant") setStatus("working");
    for (const message of parseTranscriptLine(line)) onMessage(message);
}
```

- adicionar helper `rawType(line)` (parse defensivo do JSON, retorna `entry.type`)
- `setStatus(s)` guarda o último estado e só chama o callback em transição
- timer de inatividade (debounce ~8–10 s) que força `idle` se nada novo chegou
  após uma linha não-`result`
- expor `onStatus` no objeto retornado pelo `follow()` (hoje só tem `dispose`)

### 3. `src/api/symposiumApi.ts` — propagar o status pelo follow

- a sessão seguida passa a ter uma fonte de status própria (`FollowHandle.onStatus`)
- `sessions.status(id)` consulta o último status conhecido do follow **como
  fallback** quando `LiveSessions.statusFor(id)` for `undefined`
- registrar/limpar o último status por `sessionId` enquanto o follow está ativo

### 4. `src/ui/chatSurface.ts` e `src/ui/terminalSession.ts` — assinar `onStatus`

- onde já chamam `adapter.follow(info, …)` (`chatSurface.ts:863`,
  `terminalSession.ts:193`), assinar `handle.onStatus?.(s => …)`
- refletir o estado na árvore/cabeçalho usando o **mesmo indicador** já existente
  em `chatClient.ts` (~l.1578)

## Pontos do código (referência rápida)

| Arquivo | Linha | O quê |
|---|---|---|
| `src/sessions/runtime.ts` | ~34–40 | `LiveSessions.statusFor` (usa `controller.isBusy`) |
| `src/sessions/runtime.ts` | ~45–51 | `liveInfos` |
| `src/adapters/claude.ts` | 538–610 | `follow()` (tail JSONL, sem noção de turno) |
| `src/adapters/claude.ts` | 659 | `parseTranscriptLine()` (descarta `result`) |
| `src/adapters/claude.ts` | ~163/272 | `ClaudeSession.turnActive` (limpo ao ver `result`) |
| `src/api/symposiumApi.ts` | ~67/85 | `sessions.status(id)`, `sessions.follow(id, observer)` |
| `src/ui/chatClient.ts` | ~1578 | render do indicador baseado em `s.status` |
| `src/ui/chatSurface.ts` | 863 | consumidor de `follow` |
| `src/ui/terminalSession.ts` | 193 | consumidor de `follow` |
| `src/api/bridge.ts` | 214 | consumidor de `follow` (SSE) |

## Garantias

- Mudança **aditiva e opcional** (`onStatus?`): adapters sem suporte continuam
  funcionando, sem regressão.
- O sinal `result` já é usado com sucesso pelo `ClaudeSession`, então é confiável
  para o caminho de follow também.

---

Memória Sufficit relacionada: decisão `7d1c7ea4-7144-4207-8f0b-8da0b565590a`.
