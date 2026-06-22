# Symposium — Architecture

Host and conduct dialogue sessions with multiple AI agents (Claude Code, Codex
CLI, GitHub Copilot CLI, and OpenAI-compatible HTTP backends like Sufficit AI)
inside VS Code. No runtime dependencies — VS Code API + Node only.

## Layers

```
adapters/            AgentAdapter + AgentSession contract, one per backend
  claude/codex/copilot   CLI-backed (spawn, stream-json / JSONL)
  openai                 HTTP-backed (chat completions OR responses), multi-instance
  todos / builtins / skills / scrub / exec   shared adapter helpers
sessions/
  runtime (LiveSessions)  registry of live ChatControllers (survive view switches)
  store (SessionStore)    per-session metadata in globalState (titles/archived/pinned)
ui/
  chatController     per-session state: stream coalescing, queue, injections
                     (todo/autonomy), edited-files tracking, snapshot coordination
  chatSurface        wires ONE webview to the machinery (ready handshake, git
                     filtering, active-file context, message routing)
  chatHtml           the chat VIEW (HTML+CSS+JS in one template literal) ⚠ large
  chatPanel/chatView editor-panel and sidebar hosts of a ChatSurface
  configPanel/configHtml   dynamic config webview (backends, resources, sync)
  terminalSession    terminal-backed sessions (visible CLI, driven by sendText)
api/
  symposiumApi       public facade over running state (sessions/backends/resources)
  bridge             optional remote control (HTTP + SSE), off by default
config/ root + seed  ~/.symposium vendor-neutral knowledge (agents/skills/tools)
sync/ hubClient+sync  pull/push against the sufficit-ai memory/vault hub
git.ts               diff/approve/reject + pendingChanges (two-way git sync)
snapshots.ts         per-session pre-edit baselines for revert without git
```

## Key flows

- **Session lifetime**: `runtime.create(adapter, options)` → `ChatController`
  owns the `AgentSession`; the controller keeps running when the view switches
  (detach/attach + replay log). Only explicit delete/dispose stops it.
- **Agent hand-off**: `ChatSurface.switchBackend(target)` reconstructs the
  current dialogue from the controller's render log (`transcript()` /
  `transcriptMessages()`), opens a fresh session on `target` in the same
  surface seeded with that text (`SessionStartOptions.seedHistory`, injected
  once before the first user message), and replays the visible exchange as
  `carried` history so it reads as one continuous conversation. The source
  controller is only detached (keeps running). Continuity is a seeded context
  prefix, not a native cross-backend resume (each backend owns its own ids).
- **Streaming**: adapters emit normalized `AgentEvent`s; the webview coalesces
  consecutive `text` deltas into one assistant message (Claude uses
  `--include-partial-messages`; OpenAI streams SSE deltas).
- **Edited files**: controller is the source of truth (survives switches); the
  surface filters it against live `git status` (staged → hidden, unstage →
  reappears) and pushes `changed-files` to the webview.
- **Revert**: snapshot (pre-edit baseline captured by the adapter) is primary;
  git restore is the fallback. Approve = `git add`.
- **GUID everywhere**: session id (UUID) is the canonical, backend-agnostic key
  (store, snapshots, persistence, future memory linking).

## Persistence map

| What | Where |
|------|-------|
| titles / archived / pinned order | `globalState` (SessionStore) |
| pre-edit snapshots | in-memory (per session, cleared on delete) |
| OpenAI/API transcripts | `~/.symposium/sessions/<backend>/<id>.json` |
| agents/skills/tools/instructions | `~/.symposium/repo` |
| extra adapters / settings | `settings.json` (`symposium.*`) |

## Known debt (see review 2026-06-15; refresh 2026-06-21; namespace pass 2026-06-22)

The 2026-06-22 namespace pass (see `docs/PLAN-namespace-restructure.md`, Phase
0+1) added a CI-enforced 400-line guard (`scripts/check-file-size.mjs`) and split
every adapter (`claude`/`codex`/`copilot`/`openai`), `aiTools`, and `extension.ts`
into folder modules behind barrels — all source files are now ≤400 lines except a
tracked EXEMPT set (the webview blobs below, plus `chatSurface`, `chatController`,
and `openai/session` which carry the live turn/view flow and are deferred to a
phase verified under a running Extension Host / F5).

The 2026-06-21 architecture pass (see `docs/PLAN-architecture-refactor.md`)
closed several of these. Remaining items need a running Extension Host to verify.

1. **OPEN.** The webview client (`chatClient.ts`, ~2.3k lines) + styles
   (`chatStyles.ts`) ship as template-literal strings — untyped, escape-prone.
   Highest-priority refactor: extract to real modules, esbuild-bundle into
   `media/`, load via `asWebviewUri`, and import `ui/protocol.ts`.
2. **PARTLY RESOLVED.** The webview↔extension protocol now has a single source of
   truth in `ui/protocol.ts` (`WebviewToHost` discriminated union); the host
   (`chatSurface`/`chatController`) is typed against it. The webview side becomes
   typed once it is extracted (item 1).
3. **RESOLVED.** A `node --test` suite exists (parse, todos, snapshots, openai
   adapter, outbound prompt, git) — 45 tests, run in CI.
4. **WON'T DO.** `AgentAdapter`'s granular optional capability methods are typed
   and documented; collapsing into one `capabilities()` is high-churn/low-gain.
5. **OPEN.** `ChatController` / `ChatSurface` concentrate many responsibilities;
   split incrementally alongside item 1.

Also added 2026-06-21: ESLint (flat config) + Prettier + CI lint gate, hardened
`tsconfig`, full English-only i18n pass, and typed agent/model fields on the
adapter contract (removing `as any` escape hatches).
