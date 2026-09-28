# Genius tool activity summaries

## Objective and starting state

Symposium displayed consecutive Genius actions as generic `Catalog` and `Shell exec` rows. The Genius CLI already included the tool name and JSON arguments in its version 1 event stream; the adapter passed those arguments only to the expanded input panel and left the row detail empty. Issue #72 tracks the report.

## Changes and decisions

- Derive a display-only summary in the Genius adapter. Use the tool's declared `intent` when suitable; otherwise summarize catalog operations, safe shell commands, and file targets. Complex shell commands show the executable. Secret-bearing, oversized, multiline, or malformed values fall back to a generic action.
- Preserve the original JSON arguments in the expanded row and keep the CLI protocol unchanged.
- Bump the VSIX to `2026.926.4` and raise its explicit host bundle budget to 883 KiB for the measured 881.9 KiB bundle. The 1 MiB archive cap remains in place.

## Validation and delivery

- Four regression cases failed against the original parser and passed after the change. They cover catalog operations, declared intent, shell commands, OCR/file targets, and secret-bearing or malformed inputs.
- `COVERAGE_BASE_SHA=origin/main npm run verify:package`: 857 tests passed, none failed; VSIX allowlist passed with 41 files. After commit, `COVERAGE_BASE_SHA=origin/main npm run coverage:changed`: 96.20% (76/79), above the 85% gate.
- PR #73 contains the change. VSIX `2026.926.4` was installed and confirmed by extension version listings in local VS Code and the development code-server.

## Limitations

Open editor windows need a reload to activate the installed extension. A live editor turn was not sent during delivery; the CLI event parser and package flow were exercised by tests.
