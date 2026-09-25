# Recover recent session history — 2026-09-25 17:39 BRT

Objective: restore the recent part of long Symposium sessions after scroll-up pagination, specifically Codex session `01a0ce1d-be90-7c11-a1c6-fbcb7e76e3e6` (“genius - layout”).

Starting state: the native Codex transcript (137 MB) and Symposium render ledger (16.6 MB) both retained the latest turn. The ledger's final row was a 434-message older `history` page with `replace:false`, appended after the latest response. `readRenderPage` therefore treated that old page as the newest page on reopen, hiding the recent activity.

Changes: `ChatController.loadMoreHistory` now sends older pages to the live projection without persisting them as new tail events. `readRenderPage` skips the legacy `replace:false` pages already present on disk when selecting page boundaries and visual records. The append-only ledger itself was not changed. Two regression tests cover both the read-side recovery and the prevention of new stale rows.

Decision: preserve all existing ledger bytes; repair the reader and prevent future bad writes. First-page `history` records remain supported, and older turns remain available through scroll-up pagination.

Validation: The two regression tests failed before the fix and passed after it; all 12 render-log tests passed. A read-only reconstruction of the affected session returned 173 recent records with the latest user prompt and Genius layout answer, and no obsolete page. `rtk npm run verify` passed (format, lint, typechecks, tests/coverage, guardrails, architecture, extension/PWA build); `rtk git diff --check` passed.

Delivery: source correction and activity report are in the local worktree. No release, push, or extension installation was performed in this task; a running Extension Host continues to use its installed build until updated and reloaded.
