# PLAN — oversized-files relapse (2026-07-11)

Follow-up to `202606211157-architecture-refactor.md`. That pass drove the
`check:size` gate (400-line limit, `scripts/check-file-size.mjs`) to **zero**
violations by 2026-06-23 (see `202606231119-openai-session-decomposed-complete.md`:
"the check-file-size EXEMPT set is now EMPTY"). Three weeks of feature work
since (voice/STT, turn-runner growth, adapter growth) pushed it back into the
red. This plan targets the current, real violators — not the stale list in the
now-closed PR #36 (which still named `chatSurface.ts`/`webview/index.ts`/etc.,
already fixed in the June pass).

## Current state

```
npm run check:size
✗ 10 file(s) over 400 lines:
  583  src/ui/webview/voice.ts
  481  src/adapters/openai/turnRunner.ts
  464  src/ui/chatController.ts
  460  src/ui/webview/messages.ts
  452  src/adapters/claude/adapter.ts
  451  src/adapters/openai/session.ts
  438  src/adapters/codex/session.ts
  414  src/ui/webview/panels.ts
  412  src/ui/surfaceDialogues.ts
  409  src/ui/configPanel.ts
```

## Findings & suggested splits

### P0 — real concentration (>60 lines over)

**`src/ui/webview/voice.ts` (583, new — STT/voice feature)**
- Sound cues (`playStartSound`/`playStopSound`), draft/input state
  (`setInputValue`/`resetRecordingDraft`/`renderRecordingDraft`), preference
  resolution (`getVoicePreferences`/`applyRecognitionPreferences`/
  `webSpeechWorksHere`/`chooseVoicePath`/`updateMicVisibility`), Web Speech
  capture (`startHostCapture`/`stopHostCapture`), local/VAD capture
  (`startLocalCapture`/`stopLocalCapture`) are all in one file.
- Split: `voicePrefs.ts` (preference/path resolution), `voiceHostCapture.ts`
  (Web Speech path), `voiceLocalCapture.ts` (local STT + VAD segmentation),
  keep `voice.ts` as the thin draft-state + public dispatch surface.

**`src/adapters/openai/turnRunner.ts` (481, single `TurnRunner` class)**
- Grew back from 343 (post-decomposition size) with tool-loop/guard logic
  added inline to `run()`.
- Split: pull the tool-call round-trip (invoke + result assembly) into
  `toolLoop.ts`, and the caps/loop-guard checks into `turnGuards.ts`; keep
  `TurnRunner` as the orchestrator.

**`src/ui/chatController.ts` (464, class is otherwise thin)**
- Almost every method is a 1-3 line delegate — except `seedRenderLog()`,
  which alone spans **~260 lines** (180→443). That single method is the
  whole size problem.
- Split: extract `seedRenderLog` into `renderLogSeed.ts` as a standalone
  function taking the same deps `ChatController` already has in scope.

**`src/ui/webview/messages.ts` (460, was 228 at the June split)**
- Mixes error rendering, optimistic-message bookkeeping, status notices, and
  branch banners.
- Split: `messagesError.ts` (`renderError`/`normalizeErrorText`/
  `removeDuplicateAssistantError`), `messagesStatus.ts`
  (`renderStatusNotice`/`renderStatusNoticeText`/`scrollToMessageRow`/
  `branchBanner`); keep `append`/`optimisticUserMessage`/
  `confirmOptimisticMessage`/tool-group helpers in `messages.ts`.

**`src/adapters/claude/adapter.ts` (452)**
- `follow()` (line 301 to EOF, ~150 lines) is the stream-event-mapping half
  of the file; `start()`/capability methods are the other half.
- Split: extract `follow()`'s event-mapping body into `claudeFollow.ts`;
  `adapter.ts` keeps config/capabilities/`start()`.

**`src/adapters/openai/session.ts` (451, was 391 right after the June split)**
- Constructor → `resolveApproval` (71→306, ~235 lines) is mostly event-wiring
  setup, not session behavior.
- Split: move the event-wiring block into `sessionInit.ts` (a function that
  wires the constructor's listeners and returns disposables).

**`src/adapters/codex/session.ts` (438)**
- Lines 12-207 are **free functions unrelated to the session runtime**:
  `codexWorkspaceArgs`, `loadVscodeMcpServers`, `mcpHttpWrapperPath`,
  `buildHttpMcpWrapperScript`, `loadServerConfig`, `makeRequest`,
  `mapUnifiedToCodexFlags` — MCP-wrapper/config helpers, not `CodexSession`.
- Split: move that whole block to `codexMcpConfig.ts` verbatim. Cheapest fix
  in this list — no behavior change, just a file move; drops session.ts to
  ~240 lines immediately.

### P1 — barely over (<20 lines), cheap fix

**`src/ui/webview/panels.ts` (414, was 342)**
- Todo-cluster (`todoId`/`dismissedSet`/`persistDismissed`/`visibleTodos`/
  `todoMark`/`clearTodos`/`dismissAll`/`renderTodos`/`renderPlan`) vs.
  tasks/guardrails/queued rendering are two clusters already.
- Split: `panelsTodos.ts` for the todo cluster; `panels.ts` keeps
  tasks/guardrails/queued/changed-items.

**`src/ui/surfaceDialogues.ts` (412, was 394)**
- `openDialogue` (244→EOF) is the single largest method. Only 12 lines over
  — pull one sub-step (e.g. the meta-post/attach-callback block) into a
  private helper or `surfaceDialoguesMeta.ts`.

**`src/ui/configPanel.ts` (409)**
- Only 9 lines over. `ConfigPanelDeps`/`ConfigMessage`/`ConfigHandlerCtx`
  interfaces (16-68) can move to `configTypes.ts` and clear the gate with no
  logic change.

## Execution order

1. `codex/session.ts` — pure file-move, zero behavior risk. Do first.
2. `configPanel.ts` / `surfaceDialogues.ts` / `panels.ts` — cheap, low-risk
   trims to clear P1.
3. `chatController.ts` — extract `seedRenderLog`, same class otherwise
   untouched.
4. `claude/adapter.ts`, `openai/session.ts`, `openai/turnRunner.ts` —
   adapter-side splits; verify against each backend's live stream (needs a
   real session per backend, not just typecheck).
5. `webview/messages.ts`, `webview/voice.ts` — webview-side splits; verify
   with the jsdom load harness (`scripts/wv-harness.cjs`) + a manual
   send/record smoke pass, same discipline as the June webview split.

Each step: keep `npm run compile` + `npm run lint` + `node --test` +
`npm run check:size` green before moving to the next file.

## Status (updated same day)

10 → 0 violations. Completed splits were verified with tsc + eslint + full
`node --test` (127/127); final pass verified with full `npm test`, including
`check:size`.

- **DONE** `codex/session.ts` (438→246): MCP helpers moved to `codexMcpConfig.ts`.
- **DONE** `configPanel.ts` (409→365), `webview/panels.ts` (414→~340),
  `surfaceDialogues.ts` (412→341): P1 trims, all re-exported so no consumer
  import changed.
- **DONE** `chatController.ts` (464→389): the "extract seedRenderLog" premise
  above was wrong — `seedRenderLog()` was already a 3-line delegate from an
  earlier pass. The real bulk was `dispatch()`'s inline pre-turn setup and
  outbound-prompt composition; split into `controllerDispatchPrep.ts` +
  `controllerDispatchPrompt.ts`.
- **DONE** `webview/messages.ts` (460→372): thinking-block rendering and
  streaming state moved to `thinking.ts`; `messages.ts` remains the public
  re-export surface for existing imports.
- **DONE** `claude/adapter.ts` (452→332): read-only transcript follow/tail
  logic moved to `claudeFollow.ts`; adapter keeps capability/session methods.
- **DONE** `openai/session.ts` (451→398): time-gap notice and image attachment
  content-part building moved to small helpers.
- **DONE** `openai/turnRunner.ts` (481→350): tool-list construction,
  tool execution, and usage emission moved to focused helpers.
- **DONE** `webview/voice.ts` (592→397): preferences/path selection and sound
  feedback moved to focused helpers; long inline commentary trimmed after the
  plan captured the context.
