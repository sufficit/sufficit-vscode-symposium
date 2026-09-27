# Web search activity labels — 2026-09-27 12:03

## Objective and starting state

Make the web-search activity row explain what is known without another model request or tokens. A Codex `web_search` event can arrive with only `action: {"type":"other"}`, which has no query or URL. The old row showed `Searched web`, generic `Tool call`, and that opaque JSON. Historical AHP projection also supplied `Tool call` when detail was absent.

## Changes and decisions

- The Codex item parser retains a real query/URL when provided; otherwise it labels the limitation as `Search terms not provided by Codex` and omits the useless `{"type":"other"}` input.
- The webview normalizes legacy live/historical rows with missing or generic detail to `Search terms not available in this record`; it does not attribute an unspecified legacy provider to Codex. It also hides only that exact opaque input marker, preserving other inputs.
- Added parser and DOM tests for informative and opaque cases. No new visual treatment, model call, token use, or invented search term.

Reference lock and decision ledger: preserve the existing Symposium activity rail, icon and typography (incumbent UI); use the user's screenshot as the problem reference; follow Impeccable's explicit loading/action copy guidance and Refero's anti-AI-slop craft rule by improving the factual label without decorative UI. No theme or layout token changed.

## Validation

- `npm test`: passed, including coverage and engineering/architecture guards.
- `npm run compile`: passed; VS Code and PWA bundles built.
- `npm run format:check`, `npm run lint`, `npm run typecheck:webview`, `git diff --check`: passed.
- Focused parser/DOM tests: 27/27 passed after `compile:test`.
- Impeccable detector on the changed UI files: `[]` (no findings).

The first full test attempt found `tools.ts` over the repository's 400-line cap; normalization was moved to `toolMetadata.ts`, and the full suite then passed. A later focused test invocation failed only because the full production compile clears test-only modules; `compile:test` followed by the same test passed.

## Delivery and limitation

Codex does not expose the actual query for `action.type=other`; Symposium cannot truthfully show terms absent from the event. The row states that limitation instead of pretending to know the query.

Release `v2026.927.3` is being prepared from `develop`. Strict `npm run verify:package` passed with the release guardrail, formatting, lint, TypeScript, all tests/coverage, engineering and architecture checks, compile, and VSIX allowlist (41 files, 533841 bytes). Installation and publication references are recorded after they complete.
