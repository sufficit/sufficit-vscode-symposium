# Genius session title synchronization

## Objective and starting state

Symposium stored renamed Genius titles as local overrides. Genius Desktop could not see them, and later Desktop renames were hidden by the override. Issue #74 tracks bidirectional synchronization.

## Changes and decisions

- Genius owns the canonical title. Symposium renames through `genius sessions rename UUID TITLE --json` and clears its local override only after CLI confirmation.
- A periodic native session check detects Desktop title changes and refreshes open session lists and headers. A preexisting Symposium-only override is migrated to Genius once. A failed migration retains the override for retry.
- Other adapters retain their existing local rename behavior. The adapter documentation describes the CLI requirement and reconciliation policy.
- Bump the extension to `2026.926.5`. The measured host bundle is 905267 bytes, so its explicit cap rises from 883 to 885 KiB; the VSIX archive cap is unchanged.

## Validation and delivery

- Regression tests cover CLI invocation, native rename, legacy override migration, Desktop-to-Symposium refresh, and failure retention.
- `npm run test`: 861 tests passed. `npm run check:size` and `npm run check:vsix` passed. Full package validation passed except the former bundle cap; the measured adjustment subsequently passed `check:vsix`.
- Changed-line coverage and delivery: pending at the time this note was drafted. Companion Genius issue #1020 and PR #1021 provide the native command.

## Limitations

The desktop-to-Symposium refresh interval is 10 seconds. A legacy local override wins on first migration because the previous format has no timestamp for resolving simultaneous edits.
