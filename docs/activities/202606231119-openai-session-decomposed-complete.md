# openai/session.ts decomposition (COMPLETE) — 400-line goal reached

**Shipped:** v0.79.196–0.79.199 (local VS Code + code-server `development`)
**session.ts:** 991 → 391 lines. **The check-file-size EXEMPT set is now EMPTY — every source file ≤ 400.**

## Increments

| inc | what | new file | session → | version |
|---|---|---|---|---|
| 1 | SSE stream parser | streamConsume.ts (183) | 991→831 | 0.79.196 |
| 2 | context compaction | compactor.ts (157) | →721 | 0.79.197 |
| 3 | windowing/estimate (pure fns) | requestWindow.ts (69) | →645 | 0.79.198 |
| 4 | per-turn streaming loop | turnRunner.ts (343) | →391 | 0.79.199 |

## inc4 — TurnRunner (the risky one)

`run()` (274 lines, the agent core: auth/model guards → tool-call loop → POST →
consumeStream → run tools → round-trip → caps/loop-guards → ledger commit → auto-compact)
moved into `TurnRunner.run()`. TurnRunner **owns the in-flight `AbortController`**; session's
`cancel()`/`dispose()` delegate to `runner.cancel()`, and `send()` calls `runner.run()`.

`TurnRunnerDeps` (~24 entries) reaches session state via getters/callbacks:
`getMessages`/`getProgress` (live arrays, mutated in place), `bumpTurnNo`/`getTurnNo`,
`get/setLastInputTokens`, `emit`, `model`/`label`/`contextWindow`/`headers`/`authToken`/
`discoverModels`/`followupAnchor`/`emitRequestEstimate`/`shellExecutionMode`/`resolveToolPath`/
`safePersist`/`led`/`maybeAutoCompact`, plus `cfg`/`options`/`sessionId`/`backend`/`hub`.
Constructor-body-initialized (after `sessionId` + `compactor`; eager cfg/options reads).

All the tool-exec + stream imports (AI_TOOLS*/LOCAL_TOOLS*/SUBAGENT_TOOLS*/filterTools/
runAiTool/lmTool*/diffCounts/editDiff/snapshots/friendlyToolDetail/toolPath/consumeStream/
toResponsesInput/requestWindow) moved to turnRunner.ts and were dropped from session.
session.ts keeps only: state, send (builds the user turn), persist/ledgerMeta, model/label/
contextWindow, followupAnchor, headers/authToken/discoverModels, led, shellExecutionMode/
resolveToolPath, aiTools/setAiTools, cancel/dispose, emitRequestEstimate — wiring Compactor +
TurnRunner together.

## ⚠ Verification gap

`run()` (the streaming turn loop), compaction, and windowing have **no unit-test or jsdom-harness
coverage** — they only execute against a live Sufficit AI gateway. The mechanical move is
tsc-clean (TS would flag any missed `this.` reference) and a verbatim body copy, but it MUST be
confirmed by a real Sufficit AI chat: send + stream a reply, tool calls (incl. a file edit →
changed-files), `continue` after a cap, `cancel` mid-stream, `/compact`, and a long chat (>40
msgs) for windowing.

## Result

Both god-objects are decomposed. The 400-line rule (`scripts/check-file-size.mjs`, run in
`npm test`) is now enforced with **zero exemptions** across the whole `src` tree.
