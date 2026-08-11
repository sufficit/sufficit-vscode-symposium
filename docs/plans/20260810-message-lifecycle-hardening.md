# Message-lifecycle hardening — 2026-08-10

## Symptom (recurring, user-reported 4×)

A message sent from the composer appears in the transcript AND as a row in the
QUEUED panel at the same time. The queue row is client-only ("fila falsa"): the
host queue is empty, clicking the row does nothing, and it survives until the
reducer state happens to be rebuilt from a snapshot.

## Architecture (as shipped today)

The sidebar webview runs on the AHP transport by default
(`symposium.chat.transport` = "ahp"). The pipeline per message:

```
composer.ts ──send──▶ AhpMessagePortTransport
                        ├─ optimistic chat/pendingMessageSet (id = clientMessageId)
                        └─ routeAhpClientAction ─▶ api.sessions.send ─▶ ChatController
ChatController ─render events─▶ shadowRuntime ─projectAgentEvent─▶ AHP actions
AHP actions ─frames─▶ webview localAhp ─chatReducer─▶ ChatState
ChatState/action ─ahpActionToLegacy─▶ legacy messages ─▶ dispatch.ts ─▶ DOM
```

The optimistic pending row has exactly two cleanup paths:

1. `chat/turnStarted` with `queuedMessageId === id` → reducer removes it.
2. Host `projectQueue` diff → `chat/pendingMessageRemoved {id, kind}`.

Path 2 only fires for ids the host ever tracked (message actually sat in
ChatQueue). For a direct dispatch the host never tracked the id, so path 1 is
the ONLY cleanup.

## Root causes

RC1 — `chatReducer.startTurn` guard: `if (!turnId || state.activeTurn) return state;`
Any stuck `activeTurn` (missed turnComplete: codex "duplicate turn-end
suppressed", transport reconnect, generation race) makes the reducer drop every
later `turnStarted` WHOLE — including the `queuedMessageId` cleanup. Meanwhile
`SymposiumAhpState.apply` returns true for ignored actions, so
`ahpActionToLegacy` still renders the user bubble. Result: bubble + immortal
fake queue row.

RC2 — `startTurn` never clears `steeringMessage`, only `queuedMessages`. The
steer variant of the same ghost.

RC3 — `ahpChatToLegacy`/pending rebuild ignores `steeringMessage`, so a
steering pending row is invisible in the QUEUED panel (inconsistent with the
host queue, which holds it at the head).

RC4 (hardening) — no self-healing: an optimistic row that misses both cleanup
paths lives forever. Nothing reconciles client pending state against host
truth.

## Fixes

F1 (RC1): startTurn supersedes instead of dropping. When `activeTurn` exists,
finalize it into `turns` (as interrupted) and start the new turn. The
`queuedMessageId`/steering cleanup always runs.

F2 (RC2): startTurn clears `steeringMessage` when its id matches
`queuedMessageId` — and ALSO unconditionally when the started turn's message
text equals the steering text (id lost paths).

F3 (RC3): legacy queue rebuild includes `steeringMessage` as the head row with
`mode: "steer"`.

F4 (RC4): every `chat/turnComplete`/`chat/turnCancelled` prunes pending rows
whose id was consumed by any turn in `turns` (conservation sweep). Cheap, runs
on turn boundaries only.

## Invariant tests (new suite)

`src/test/ahpMessageLifecycle.test.ts` — full pipeline simulation
(projectAgentEvent + chatReducer + ahpActionToLegacy round trip, no DOM):

For each (mode ∈ send/queue/steer/redirect) × (host busy/idle) ×
(activeTurn fresh/stuck):

- CONSERVATION: after the turn for a clientMessageId starts, that id appears
  exactly once as a user row in the legacy stream and zero times in
  `queuedMessages`/`steeringMessage`.
- NO-DROP: a turnStarted is never silently ignored — either it starts a turn
  or it supersedes one, and its cleanup side effects always apply.
- STEER-VISIBILITY: a steering pending row is present in the queue rebuild
  until consumed.

## Audit appendix (Opus, 2026-08-10) — 12 further confirmed defects

Shipped in this delivery (batch 2):

- D1 Rejected client actions still rendered UI (`state.apply` returned true on
  rejectionReason without reducing; localAhp translated the rejected envelope).
- D2 Rejected `chat/turnCancelled` faked a turn-end (composer unlocked while
  the host kept streaming); transport also swallowed cancel when client had no
  activeTurn.
- D3 Rejected `chat/toolCallConfirmed` removed the approval card while the host
  still waited.
- D4 Rejected send left a permanent ghost optimistic bubble + stuck busy (no
  withdraw path).
- D5 Busy had NO host→client correction under AHP (AHP queue rebuilds carried
  no `busy` field; the authoritative-busy branch in dispatch.ts never fired).
- D6 Transport `pendingMessageRemoved` always sent kind "queued", so a steering
  row could never be cleared by the reducer.
- E1 Mid-turn injected steer never reached the AHP client (shadowRuntime
  stashed the user row and dispatched nothing; message absent from ChatState).
- E2 `pendingUser` one-slot cache never cleared at turn end → blank/stale user
  bubbles on retry-with-interruptedBy and continue-after-tool-cap.
- E3 Restored queue projection lost its id map (attach/rebuild start from an
  empty `QueueProjectionState`), stranding immortal queue rows after restart.

Deferred (documented, not yet implemented):

- #9 Turn id reuse on retry/continue duplicates ids in `ChatState.turns`
  (dedup drops one on history reload; truncate cuts at the first match).
  Suggested: namespace projected id per attempt.
- #10 History pagination ids are page-local (`history-${index}`), so page ≥2
  collides and never enters ChatState.
- #12 Several render messages bypass AHP entirely (retry notice, fatal send
  error, quota, write-roots) — DOM-only, lost on rebind; fatal send error
  leaves busy stuck.
- Suspected: approval turnId fallback `?? ""` leaves tool rows
  pending-confirmation; ordering hazard if routeAhpClientAction ever emits
  synchronously before the optimistic dispatch; `emitChanged()` uses toSink so
  Changed Files gets no live updates in AHP mode.

## Rollout

Implementation: Sonnet agents (user directive). Review: this doc + Opus audit
appendix. Release via the standing process (verify → bump → package →
check-vsix → commit develop → tag → CI green → install local + development +
container 1021).
