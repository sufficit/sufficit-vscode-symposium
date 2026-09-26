# Genius native queue bridge

## Objective
Submitting a message while Genius is busy should place it in the Genius host queue immediately, make it visible in Genius Desktop, and still render and run exactly once in Symposium.

## Terrain and constraints
- Symposium currently queues locally until its active CLI child ends.
- Genius `exec` owns one child per turn. Native queueing requires a correlated CLI stream to avoid mixing events.
- Existing queue panel actions and recovery semantics must remain coherent. Preserve unrelated worktree changes.

## Checkpoints
- [x] Inspect screenshots, logs, queue/router, and adapter. **Completed.**
- [x] Connect busy submissions to Genius native queue with correlated child lifecycle. **Completed.**
- [x] Add focused regression coverage and run package verification. **Completed.**
- [ ] **Current:** Document, deliver through PR/merge, and install locally for validation.

## Decision
Keep Symposium's queue as a UI projection while the Genius host owns execution. The adapter pre-submits with the same client message ID, then attaches the local turn to the existing CLI process when it reaches the front.

## Validation
Adapter prequeue, immediate removal, cancellation, and missing-result tests pass. Aggregate `verify:package` passed before the final regression cases (851 tests). With those cases, 853 tests pass and changed-line coverage reaches 85.55% (302/353), clearing the CI threshold. Size, complexity, architecture and VSIX checks pass.
