# Release of recent-session history recovery — 2026-09-25 18:21 BRT

Objective: commit, push, merge, and release the completed Symposium recovery for recent history in long sessions.

Starting state: `develop` and `origin/develop` were at `25652fb` (`v2026.925.1`). The local checkout contained only the completed history fix and its activity report. PR #60 for the Genius CLI adapter was open as a draft in a separate worktree, with its own planned version `.3`; it was not included in this `.2` hotfix.

Changes delivered: `1310d1f` prevents scroll-up history pages from being appended as new conversation tail events, ignores legacy stale pages during recent-page reads, and adds two regression tests. Version files were synchronized at `2026.925.2`. Packaging now excludes local `.worktrees/` and VSIX files, and the host bundle budget was raised narrowly from 864 to 865 KiB after the fix added 75 bytes over the prior limit; the 1 MiB archive cap remains.

Validation: `COVERAGE_BASE_SHA=25652fbb49c148acd64ff8e16c1e2868aec5d861 npm run verify:package` passed, including changed-line coverage. The local VSIX contained 41 allowlisted files and was 528,832 bytes. PR #62's CI `build` check passed. The first packaging attempt exposed `.worktrees/` inclusion and produced an incomplete 190 MB artifact; that generated artifact was removed, the packaging exclusion was added, and the final package was validated.

Delivery: release branch `release/2026.925.2-recent-session-history` was pushed, [PR #62](https://github.com/sufficit/sufficit-vscode-symposium/pull/62) merged into `develop` as `409923f`, and annotated tag `v2026.925.2` was pushed on that merge commit. [Publish run 36190766899](https://github.com/sufficit/sufficit-vscode-symposium/actions/runs/36190766899) succeeded, including publication steps for Visual Studio Marketplace and Open VSX. [GitHub Release v2026.925.2](https://github.com/sufficit/sufficit-vscode-symposium/releases/tag/v2026.925.2) contains the 529,721-byte CI-built VSIX.

Known limitation: immediately after publication, public marketplace `latest` endpoints still reported `.1` despite successful publish logs, so catalog propagation may take time. Desktop VS Code already listed `.2`; the development code-server listed a separate, newer `.4` build from the draft Genius work and was deliberately not downgraded. No Extension Host was restarted, so open windows may need reload to activate their installed version.
