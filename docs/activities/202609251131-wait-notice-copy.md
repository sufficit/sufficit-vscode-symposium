# Wait notice copy — 2026-09-25 11:31 BRT

Objective: Preserve the Symposium 30-second wait notice while avoiding the false impression that a pending Sufficit AI request has failed; compare Genius behavior.

Starting state: `turnStream.ts` emitted “Sufficit AI has not responded for over 30 seconds” once per request without visible text/reasoning/status. The notice remains informational, is persisted in chat, and does not stop the turn. The release was prepared in a clean worktree because Genius adapter edits appeared in the primary checkout during this task.

Changes: Reworded the Symposium notice to “No visible update from Sufficit AI for over 30 seconds. This turn is still active; completed tool results are saved.” Updated timer, AHP history, and render replay tests to cover the new copy. Timing, severity, persistence, and retry behavior are unchanged.

Genius comparison: In the separate Genius app, `GeniusSession.Turn.cs` dispatches provider `Status` events to `ChatProgress`; `ChatTranscript.razor` renders progress or a typing indicator during an active turn. `GeniusSession.TransientRetry.cs` renders scheduled retries only after a classified transient failure. No fixed 30-second no-visible-output notice was found. During final review, untracked `src/adapters/genius/` files appeared concurrently in the primary Symposium checkout; `adapter.ts` emits a warning on event-stream reconnection but has no 30-second wait notice. Those adapter files and Genius's unrelated Asaas edits were left untouched.

Decision: The user's brief keeps the warning. Existing Symposium presentation is the reference lock. Refero's product-copy guidance and Impeccable's loading/error guidance favor a factual description of visible state over an unsupported claim that the provider failed.

Validation: Six focused tests passed. Full `npm test`, `npm run format:check`, `npm run lint`, `npm run typecheck`, and `git diff --check` passed before isolating the changes. The clean release worktree will be verified again with `npm run verify:package`. No installation or release happened before this authorized release workflow.
