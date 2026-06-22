# PLAN — Namespace Restructure & 400-Line Decomposition

Status: **DRAFT** (2026-06-21). Supersedes the two items deferred by
`docs/activities/20260621115747-architecture-refactor.md` (#2 webview
extract+bundle, #8 god-object split) and folds them into one namespace-first
restructuring. Migrate this file to `docs/activities/<ts>-*.md` when finalized.

## Goals (hard constraints)

1. **No source file > 400 lines.** Enforced by CI, not by discipline.
2. **Namespace architecture** — feature folders with a barrel (`index.ts`) as the
   only public surface; deep files stay private to their namespace.
3. **Distribute responsibilities** — one concern per file. Split the four
   god-objects (`chatClient`, `chatSurface`, `OpenAISession`, `extension.activate`).
4. **Frontend control framework** for the webview client (today: one 2.7k-line
   untyped template-literal string) → typed, modular, bundled.

## Invariants to protect (do NOT break)

- **Zero runtime deps in the extension host.** devDeps only. esbuild is a
  build-time dep — fine. Any webview framework ships *bundled into `media/`*, it
  is never a host `dependencies` entry.
- Adapter contract (`AgentAdapter` / `AgentSession`) stays the core seam.
- Backend-agnostic GUID session keys.
- Webview CSP + nonce; bridge localhost + bearer + 0o600.
- English-only strings/comments.
- Every step keeps `npm run compile` + `npm run lint` + `node --test` green.

## Baseline — files over 400 lines (the work queue)

| Rank | File | Lines | Nature |
|------|------|-------|--------|
| 1 | `ui/chatClient.ts` | 2713 | webview JS as a string |
| 2 | `ui/chatSurface.ts` | 1408 | host god-object |
| 3 | `adapters/openai.ts` | 1272 | session mixes 7 concerns |
| 4 | `ui/chatStyles.ts` | 1133 | CSS as a string |
| 5 | `extension.ts` | 862 | activate() + config builders |
| 6 | `adapters/aiTools.ts` | 812 | defs + exec + terminal + dispatch |
| 7 | `adapters/claude.ts` | 802 | adapter + session + transcript |
| 8 | `ui/chatController.ts` | 546 | per-session state machine |
| 9 | `adapters/copilot.ts` | 530 | adapter + session |
| 10 | `adapters/codex.ts` | 478 | adapter + session |

---

## Target namespace tree

```
src/
  core/                      backend-agnostic domain, minimal vscode coupling
    agent/        index.ts   AgentAdapter/AgentSession contract (was adapters/types.ts)
    session/      index.ts   runtime (LiveSessions), store, controller engine
    ledger.ts  snapshots.ts  git.ts  sessionReader.ts   (moved from root)
  adapters/
    claude/       index.ts   adapter | session.ts | transcript.ts | models.ts
    codex/        index.ts   adapter | session.ts | parse.ts
    copilot/      index.ts   adapter | session.ts | parse.ts
    openai/       index.ts   adapter | session.ts | http.ts | store.ts |
                             models.ts | toolLoop.ts | transform.ts
    shared/       index.ts   parse | scrub | skills | builtins | todos | lmTools
      tools/      index.ts   defs.ts | exec.ts | terminal.ts | run.ts | types.ts
  webview/
    host/         index.ts   chatSurface (shell) | messageRouter | contextProvider |
                             attachments | backendSwitch | htmlShell
      controller/ index.ts   engine | queue | stream | injections
      panels/                chatPanel | chatView | configPanel
    client/                  ← bundled to media/ (esbuild), browser-only
      main.ts  state.ts  bus.ts  dom.ts
      components/            composer | sessionsPane | messageList | dropdown |
                            configMenu | toast | tooltip
      render/               markdown.ts | tables.ts
    protocol/     index.ts   shared WebviewToHost/HostToWebview union (was ui/protocol.ts)
    styles/                  base | layout | composer | messages | sessions | menus
  config/        sync/  auth/  api/        (already namespaced; minor splits)
  extension/      index.ts   activate/deactivate | config.ts | customAdapters.ts |
                             commands.ts | cli.ts | models.ts | errors.ts
  test/
media/
  chat.js  chat.css           build outputs (gitignored)
```

Rules for the tree:
- Import **across** namespaces only through the namespace barrel (`index.ts`).
- Import **within** a namespace by relative path.
- `core/` must not import from `webview/` or `adapters/*` (dependency points one
  way: webview → core, adapters → core).

---

## Frontend control framework (webview)

The webview is sandboxed and bundled, so its deps never touch the host
supply-chain. Recommendation, in order:

**Primary — vanilla TS + a ~40-line reactive store, bundled by esbuild.**
Keeps the zero-extra-dependency ethos, smallest bundle, no framework lock-in.
Structure:
- `client/state.ts` — single store object + `subscribe(fn)` + `set(patch)`,
  persisted via `vscode.setState`.
- `client/bus.ts` — typed wrappers over `postMessage` / `onmessage` importing
  `webview/protocol`. This closes the type loop (both ends share the union).
- `client/components/*` — each owns one DOM region, subscribes to the store,
  renders. One component = one file, all < 400 lines.

**Alternative — Lit (web components) or Preact+htm**, bundled into `media/`.
Pick only if the team wants richer component ergonomics and accepts a ~5–15 KB
bundled runtime. Same module layout; components become `LitElement`/functions.

Decision needed before Phase 1 starts (see "Open decision" at end).

Build: add `esbuild` devDep + `scripts/build-webview.mjs` producing
`media/chat.js` and `media/chat.css`. Host loads via `webview.asWebviewUri`
and drops the inline-`<script>` CSP exception. `watch` script runs esbuild in
parallel with `tsc -watch`.

---

## Per-file decomposition

### chatClient.ts (2713) → `webview/client/*`
Carve the single string by feature into typed modules:
`main` (boot/wiring), `state`, `bus`, `dom`, `components/{composer, sessionsPane,
messageList, dropdown, configMenu, toast, tooltip}`, `render/{markdown, tables}`.
Each component lifts a contiguous block already delimited by the `// ----` banners
in the current file (dropdowns, sessions resizer, markdown, tables, config menu…).
Target: every file < 250 lines.

### chatStyles.ts (1133) → `webview/styles/*.css`
Split by region (base, layout, composer, messages, sessions, menus). esbuild
concatenates to `media/chat.css`; load via `asWebviewUri` + `style-src` nonce.

### chatSurface.ts (1408) → `webview/host/*`
- `chatSurface.ts` — shell/orchestrator: owns webview, ready handshake, delegates (<300)
- `messageRouter.ts` — host-side `handleMessage(WebviewToHost)` dispatch
- `contextProvider.ts` — `activeEditorContext`, git filtering, `changed-files`
- `attachments.ts` — `writePastedImage`/`writeDroppedFile`/`attachmentFromUri`/`IMAGE_EXT`
- `backendSwitch.ts` — `switchBackend` hand-off (seedHistory + replay)
- `htmlShell.ts` — assembles HTML + `asWebviewUri` refs (was chatHtml)

### openai.ts (1272) → `adapters/openai/*`
- `index.ts` — `OpenAIAdapter` (config, factory, modelLabels) (<200)
- `session.ts` — `OpenAISession` lifecycle/events (<350)
- `http.ts` — chat + responses request builders, SSE stream parse
- `store.ts` — `storeDir/storePath/readStored/writeStored`
- `models.ts` — discovery maps + `modelContextLength`
- `toolLoop.ts` — tool-call loop, `friendlyToolDetail`, `toolPath`
- `transform.ts` — `toResponsesInput`, `contentText`, message shaping, ledger bridge

### extension.ts (862) → `extension/*`
- `index.ts` — `activate`/`deactivate` orchestration (<150)
- `config.ts` — `claudeConfig/copilotConfig/codexConfig/openaiConfig/symposiumClientInfo`
- `customAdapters.ts` — `CustomAdapterDef` + normalize/build
- `commands.ts` — `registerCommand` block
- `cli.ts` — `CLI_INSTALL`, `promptInstallCli`, `CLI_BACKENDS`
- `models.ts` — `normModel`, `resolveModelPin`
- `errors.ts` — `errorDetails`, `showErrorWithCopy`, `symposiumLog`

### aiTools.ts (812) → `adapters/shared/tools/*`
`defs.ts` (tool arrays/names/filter), `exec.ts` (runShell/rtk/path helpers),
`terminal.ts` (terminal handle registry), `run.ts` (`runAiTool` dispatch +
`htmlToText`), `types.ts` (`ToolContext`/`ToolProgressSink`/`OpenAITool`).

### claude.ts (802) → `adapters/claude/*`
`index.ts` (adapter), `session.ts` (`ClaudeSession`), `transcript.ts`
(`parseTranscriptLine/rawLineType/cleanUserText/readSessionMeta`), `models.ts`
(fallback models/labels, `imageBlock`).

### chatController.ts (546) → `webview/host/controller/*`
`engine.ts` (core state), `queue.ts` (`PendingMessage`, send/queue/steer),
`stream.ts` (delta coalescing), `injections.ts` (todo/autonomy, edited-files).

### copilot.ts (530) / codex.ts (478) → folder split
Each → `index.ts` (adapter) + `session.ts` + `parse.ts`. Lowest risk; do first
as the pattern rehearsal for the heavier adapters.

---

## Guardrail — enforce the 400-line rule

Add `scripts/check-file-size.mjs`: fail if any `src/**/*.ts` (excluding the
soon-removed blob files during transition, and `*.css`) exceeds 400 lines.
Wire into `npm test` and CI. This makes the constraint permanent, not one-shot.

```
node scripts/check-file-size.mjs   # exit 1 + list offenders over 400
```

ESLint backstop: `max-lines: ["error", 400]` in `eslint.config.mjs` (set
once the blobs are gone, so it doesn't flag work-in-progress).

---

## Phased execution (each phase = its own checkpoint + green build)

**Phase 0 — scaffolding (no behavior change). ✅ DONE (2026-06-22).**
`scripts/check-file-size.mjs` (400-line guard) wired into `npm test` + `check:size`
script; EXEMPT list tracks the F5-deferred files (webview blobs + chatSurface +
chatController + openai/session). esbuild/`media` bundling deferred to Phase 2.

**Phase 1 — low-risk leaf splits (no F5 needed). ✅ DONE (2026-06-22).**
Split into folder modules behind barrels (import paths preserved):
- `adapters/codex/` → session, transcript, adapter, index
- `adapters/copilot/` → session, transcripts, adapter, index
- `adapters/claude/` → session, transcript, models, adapter, index
- `adapters/openai/` → types, store, models, transform, toolDetail, history,
  token, session (turn loop — EXEMPT, F5), adapter, index
- `adapters/aiTools/` → defs, types, shell, run, index
- `extension/` → log, errors, cli, models, config, surfaceDeps,
  `commands/{helpers,create,sessions,misc,index}`; `extension.ts` is now a lean
  ~210-line activate() that re-exports `symposiumLog`.
Verified: `npm run compile` + `npx eslint src` (0 issues) + `node --test`
(49 pass) + `check:webview` + `check:size` (✓ all ≤400) green. Version bumped
0.79.173 → 0.79.174. Also fixed a leftover Portuguese string in the bridge
restart message ("desativado" → "disabled").
Branch: `refactor/namespace-restructure`.

**Phase 2 — webview extract + bundle (NEEDS F5).**
chatClient → `client/*`, chatStyles → `styles/*`, framework store/bus wired,
esbuild bundle, host loads via `asWebviewUri`, drop inline-script CSP. Verify
boot path in a running Extension Host: open dialogue, stream, switch backend,
attachments, sessions pane, markdown/tables, config menu, toasts.

**Phase 3 — host god-object split (NEEDS F5).**
chatSurface + chatController by concern. Verify the live message/turn flow,
edited-files filtering, and cross-backend hand-off after each split.

**Phase 4 — lock it in.**
Turn on `max-lines` ESLint rule, add size-check to CI gate, update
`ARCHITECTURE.md` (close debt #1/#2/#5), migrate this plan to
`docs/activities/<ts>-namespace-restructure.md`.

## Verification per phase

- `npm run compile && npm run lint && npm run test` green.
- Phases 2–3: manual F5 checklist above (no automated webview harness exists).
- Version bump before each packaging; keep `.vsix` out of the tree (build to
  ignored `dist/`).

## Risk notes

- Phase 1 is mechanical/safe — do it in one sustained pass.
- Phases 2–3 mutate the live boot/turn path and have **no automated coverage** —
  gate strictly on F5. Do not batch 2 and 3; checkpoint between them.
- Path aliases (`@core/*`) need a resolver. With plain `tsc` output they won't
  resolve at runtime — so use **relative imports inside namespaces + barrels
  across**, OR adopt esbuild for the host bundle too (optional, later).

## Open decision (blocks Phase 1 start)

Frontend framework for the webview client: **(A)** vanilla TS + tiny store
(recommended, zero added runtime), **(B)** Lit, or **(C)** Preact+htm.
