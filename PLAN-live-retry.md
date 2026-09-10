# Live retry integration

Objective: normal adapter error + turn-end must schedule bounded automatic retry,
with UI-only attempt/countdown notices, preserving the request and cancellation.

Terrain: clean develop at 2026.906.4. ControllerLiveState omits the recovery
callback which the dispatch catch/watchdog already supply. Existing isolated
recovery tests do not exercise this composition. Preserve unrelated changes.

Checkpoints:
1. Completed: reproduced through real ChatController (3 tests fail: no timer scheduled).
2. Completed: required callback wired through LiveState; five ChatController integration tests pass (replay, limit, cancel, queue, disabled/non-retryable).
3. Completed: full verification/package, commit d454c3b and tag v2026.907.1 pushed; local/development VSIX installed and hashes match.
4. Completed: publishing workflow 34161787070 succeeded (Marketplace, Open VSX, GitHub release).
5. CURRENT / blocked on safe activation: development PID 3951533 still has t5
   open; user decision needed before interrupting. Installed 2026.907.1 but
   active log still 2026.906.2. Do not claim runtime fix active yet.

Constraints: 400-line source limit; do not interrupt busy extension hosts. Native
plan tool unavailable in this environment, so this file tracks checkpoints.
Validation: integration test must fail before the fix, pass after it; verify:package.
Development host 45.233.44.253 runs 2026.906.2, PID 3951533. Its log has an
active turn at 21:00:41Z; do not restart that process while busy.

Validation: verify:package PASS (748 tests; lint/types/build/architecture/VSIX).
2026.907.1 installed via CLI locally and on development; remote list confirms
installed version. Activation pending: PID 3951533 still busy at 21:04Z.
Real log confirms deferred terminal error fallback at 20:39:51Z for
7ecc0fb5-3e6e-4a8f-88c0-8b2480d9bf01/turn-26 (174 seconds, matches screenshot).
Publishing workflow: https://github.com/sufficit/sufficit-vscode-symposium/actions/runs/34161787070
