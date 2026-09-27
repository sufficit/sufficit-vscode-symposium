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

Release `v2026.927.3` was built from `develop`. Strict `npm run verify:package` passed with the release guardrail, formatting, lint, TypeScript, all tests/coverage, engineering and architecture checks, compile, and VSIX allowlist (41 files, 533841 bytes).

- Commit: `c90855a74ea37fb40ce85ee444f3614746d24820` on `develop`.
- Annotated tag: `v2026.927.3`.
- GitHub Actions publication run [36328534316](https://github.com/sufficit/sufficit-vscode-symposium/actions/runs/36328534316) succeeded. Workflow logs confirm Visual Studio Marketplace and Open VSX publication; GitHub Release includes `sufficit-vscode-symposium-2026.927.3.vsix`.
- The marketplace VSIX endpoint returned HTTP 200. GitHub Release VSIX is 534661 bytes.
- VS Code local reports `sufficit.sufficit-vscode-symposium@2026.927.3`.
- Development code-server reports the same version. The copied VSIX SHA-256 matches the local artifact: `ac6203fe7272e3f88673891889fa5e5c16dc2b674ac994742b0474bc9241564b`.
- Immediately after the successful workflow, Open VSX's public metadata still showed `.2` and its `.3` version endpoint returned 404; this is registry propagation delay, as the workflow's publish step itself succeeded. Do not republish the same version unless the registry remains stale after propagation.

Already open VS Code or code-server windows keep the extension version they loaded. Reload each window when convenient to activate `.3`; no Extension Host was restarted, preserving active sessions.
