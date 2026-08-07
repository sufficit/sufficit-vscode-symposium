# Engineering and architecture hardening completed

Status: **Completed**
Date: 2026-08-07

## Activity

Completed the engineering and architecture hardening program, converted its
conventions into executable repository contracts, and replaced the working plan
with this set of dated activity records.

## Delivered

- established `npm run verify` as the source-verification contract and
  `npm run verify:package` as its release-package extension;
- made formatting, lint, extension-host and strict webview typechecks blocking;
- closed and behaviorally tested the host/webview protocol boundary;
- introduced architecture, namespace, configuration, i18n, repository, source
  size, complexity, changed-coverage and VSIX-content checks;
- removed all dependency cycles and unreachable production modules from the
  architecture inventory;
- decomposed every TypeScript source file above the 400-line hard limit;
- added shared adapter contracts, DOM-level webview tests, extension-host tests
  and truthful whole-source coverage;
- constrained release packaging to an exact allowlist and explicit size budgets;
- documented each implementation phase as an independent activity under
  `docs/activities/`.

## Final validation

`npm run verify:package` completed successfully from a clean build path:

- tests: 398 passing, zero failures;
- whole-source line/statement coverage: 40.81% (12,058 / 29,545);
- branch coverage: 66.60% (1,689 / 2,536);
- function coverage: 56.39% (507 / 899);
- architecture: 331 production modules, zero cycles and zero unreachable modules;
- configuration: 91 static settings checked;
- i18n: 386 EN and 386 PT-BR strings checked;
- source size: zero TypeScript files above 400 lines;
- complexity inventory: 50 files above the 300-line refactor target and 148
  function targets, all visible without named baselines or exception lists;
- extension bundle: 668.46 KB and successfully validated;
- VSIX: 22 allowlisted files and 381,034 bytes.

Changed-line coverage remains deterministic in CI through
`COVERAGE_BASE_SHA`; it is intentionally skipped during a local run when that
base revision is not supplied. Complexity remains advisory in the regular
verification while `npm run check:complexity:strict` provides the zero-tolerance
ratchet for progressively eliminating the visible inventory.

## Outcome

The original plan is complete and removed. Its requirements now live in code,
CI checks, tests, `ARCHITECTURE.md`, and the dated activity history rather than in
an active planning document.
