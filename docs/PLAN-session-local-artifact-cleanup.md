# PLAN — centralize permanent deletion of Symposium session artifacts

**Created:** 2026-08-01
**Status:** pending
**Origin:** remaining work from
[`20260623-render-log-persistence-partial.md`](activities/20260623-render-log-persistence-partial.md).

## Problem

Rich visual replay is implemented in `~/.symposium/ledger/<sessionId>/render.jsonl`,
but permanent deletion is inconsistent:

- `src/renderLog.ts` exports `removeRender`, with no production caller;
- the OpenAI adapter removes the whole shared Symposium ledger;
- Claude, Codex and Copilot scrub their provider-owned transcript stores but do
  not remove the shared Symposium ledger;
- the common delete command removes runtime, index and title state, but not the
  local ledger itself.

Consequently, a session deleted from some backends can leave messages and rich
render output recoverable by id and consuming disk. The adapter-dependent
behavior also violates the boundary that adapters should own provider storage,
while Symposium owns its common ledger.

## Benefit

- Makes “Delete permanently” mean the same thing for every backend.
- Removes orphaned text, tool output, diffs and render data.
- Restores the architecture boundary between provider adapters and shared
  Symposium persistence.
- Adds regression coverage for exact visual reopen and deletion semantics.

## Work

### 1. Introduce one common local-artifact cleanup boundary

- Add a focused helper under `src/sessions/` that owns deletion of Symposium
  artifacts for one stable session id.
- Invoke it from the common command only after provider deletion succeeds and
  before the final catalog refresh.
- Remove the OpenAI adapter's ownership of common ledger deletion; adapters
  continue to scrub only their provider-owned stores.
- Keep the operation idempotent so partial prior deletions can be retried.
- Preserve the existing runtime disposal, snapshot clearing, session-index
  eviction and Sufficit task expiry behavior.

The preferred operation is removal of the complete ledger directory, which
already contains `render.jsonl`; do not delete only the render file while
leaving the lossless message ledger behind.

### 2. Cover render persistence and recovery

Add tests using isolated temporary storage for:

- append/read ordering and the per-line size cap;
- corrupt or partial JSONL lines failing soft without blocking activation;
- seeding a resumed controller without re-persisting duplicate messages;
- adapter-history fallback when no render log exists;
- restored queue state appearing once.

### 3. Cover permanent deletion

For every built-in backend contract, verify that one confirmed deletion:

- calls provider scrub before shared cleanup;
- removes the common ledger and render log;
- evicts the cached session exactly once;
- remains successful when artifacts are already absent;
- retains shared artifacts when provider deletion fails, so the operation can
  be diagnosed and retried rather than reporting partial success as complete.

### 4. Product smoke test

Create a tool-heavy conversation containing thinking, status, tool, diff, queue
and panel rows; reload and reopen it; then permanently delete it. Confirm exact
visual replay before deletion and absence from disk and session discovery after
one deletion.

## Acceptance criteria

- Permanent deletion leaves no Symposium ledger or render artifact for any
  backend.
- Adapters no longer remove shared Symposium persistence.
- Exact visual reopen and fallback behavior have automated regression tests.
- Delete remains idempotent and does not recreate a generic catalog row.
- `npm run lint`, `npm test` and `npm run compile` pass.

## Non-goals

- Cross-machine synchronization of render logs.
- A new render-log schema or migration framework.
- Scrubbing provider aggregate stores that cannot safely identify one session;
  those remain reported as residual data.
