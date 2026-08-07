# PLAN — Engineering and Architecture Hardening

Status: **IN PROGRESS**
Started: 2026-08-07
Scope: extension host, adapters, sessions, webviews, PWA, tests, CI and release packaging.

## Objective

Turn the current engineering conventions into executable contracts. The project
already has a strong base — strict TypeScript in the extension host, zero runtime
dependencies, a normalized adapter contract and 385 fast regression tests — but
several protections are not applied by CI, important integration paths are not
executed by tests, and architectural boundaries are documented without being
enforced.

This plan uses incremental ratchets: first prevent the current debt from growing,
then remove the explicitly baselined exceptions without requiring a single risky
rewrite.

## Initial audit baseline (2026-08-07)

| Metric | Baseline |
|---|---:|
| TypeScript files | 351 |
| TypeScript lines | 44,671 |
| Test files | 65 |
| Tests | 385 passing |
| Production modules | 285 |
| Production modules loaded by unit tests | 92 |
| Production modules not loaded by unit tests | 193 |
| Dependency cycles | 7 |
| Files with at least 350 lines | 27 |
| Functions over 80 lines | 44 |
| Functions with estimated complexity over 15 | 94 |
| Files failing Prettier check | 290 |
| Runtime dependency vulnerabilities | 0 |
| Development dependency vulnerabilities | 3 |

The production-only coverage report for modules observed by Node was roughly 72%
lines / 71% branches / 71% functions. This is not whole-project coverage because
unloaded modules are absent from the report.

## Confirmed defects found by the audit

1. `symposium.compression.defaultPresetId` is declared in `package.json`, while
   `CompressionManager` reads and writes `defaultPreset`.
2. `CompressionManager` reads/writes undeclared `perSessionEnabled` and
   `sectionConfigs` settings.
3. The compression config UI falls back to the nonexistent preset id
   `builtin-standard`.
4. Five entries in the English configuration dictionary contain Portuguese.
5. Several compression dialogs and built-in preset labels bypass i18n entirely.
6. `ui/*` imports the `extension.ts` composition root only to obtain a logger,
   creating avoidable dependency cycles.
7. The build cleanup list does not include newer namespaces, so the VSIX contains
   duplicate compiled modules in addition to the main bundle.
8. Legacy voice-extension sources/builds and one tracked `.old` file remain in the
   repository/package inputs.

## Target architecture

```text
extension/              VS Code composition root and registrations
    ↓
application/            use cases and session orchestration
    ↓
domain/                 pure contracts, events and state
    ↑
ports/                  auth, persistence, process, clock and UI ports
    ↑
infrastructure/
  vscode/               VS Code implementations of ports
  identity/
  filesystem/
adapters/
  claude/
  codex/
  copilot/
  openai/
ui/
  host/                 webview host connected to application use cases
  webview/              typed browser client
protocol/               closed, shared host/webview message contracts
```

Dependency rules:

- `domain` imports neither VS Code, UI nor concrete adapters.
- session/application code does not import presentation code.
- UI never imports `extension.ts`; the extension composes and injects dependencies.
- adapters depend on public contracts, not UI or the extension entrypoint.
- imports crossing a feature namespace use that namespace's public barrel.
- both webview message directions use closed discriminated unions.

## Permanent verification command

`npm run verify` is the local and CI source of truth, while
`npm run verify:package` adds packaging and VSIX-content validation. The target
verification contract covers:

1. formatting after the existing repository-wide baseline is migrated;
2. ESLint;
3. extension-host typecheck;
4. strict webview typecheck;
5. unit and contract tests;
6. generated webview/config-script syntax;
7. architecture and repository guardrails;
8. production build;
9. VSIX package-content validation through `verify:package`.

Workflows must call this command rather than copy a subset of its steps.

The initial audit found 283 source files outside the current Prettier contract.
Formatting is therefore not yet a blocking `verify` step: applying it globally
would mix a repository-wide mechanical rewrite into behavioral work. Phase 2 must
introduce a controlled formatting migration (directory batches or an exact
ratchet), then promote `format:check` into `verify`.

## Required guardrails

### Source size and complexity

- Hard file limit: 400 lines.
- Warning/refactor threshold: 300 lines.
- Function target: at most 80 lines.
- Complexity target: at most 15 decisions.
- No unowned permanent exception. Temporary exceptions record owner and expiry.
- Until debt is removed, counts above the target are ratcheted and cannot increase.

### Architecture and namespaces

- Detect relative-import cycles with the TypeScript AST.
- Baseline current cycles temporarily; fail on any new cycle or expanded component.
- Enforce an allowed dependency matrix.
- Forbid `ui -> extension.ts` and domain/application imports of `vscode`.
- Detect unreachable modules from supported entrypoints.
- Reject tracked `.old`, `.bak` and `.orig` files.
- Adopt one filename convention per namespace.
- Consolidate duplicate concepts, starting with the three compression namespaces.

### Manifest and configuration contracts

- Every statically read or updated `symposium.*` setting exists in the manifest.
- Reads and writes use the same canonical key.
- Defaults and declared types are compatible.
- Every contributed command is registered exactly once.
- Internal commands are explicitly marked as internal rather than accidentally
  omitted from the manifest.

### i18n

- EN and PT-BR dictionaries have the same keys unless a fallback is documented.
- English dictionaries cannot contain known Portuguese UI phrases.
- User-visible strings live behind translation keys.
- Tests exercise both generated locale scripts.

### Webview protocol

- `WebviewToHost` and `HostToWebview` are closed unions.
- Typed wrappers are the only way to call `postMessage`.
- Handlers use exhaustive switches with `assertNever`.
- Contract tests prove that every sent message has a receiver.

### Coverage and behavioral tests

- Use whole-source coverage (`c8 --all` or equivalent), including unimported files.
- Establish the first threshold from a truthful all-source report, then ratchet it.
- Changed-line coverage target: at least 85%.
- Replace source-text assertions with behavioral tests where practical.
- Add VS Code Extension Host integration tests.
- Add DOM-level webview tests.
- Run a shared adapter contract suite against deterministic fake Claude, Codex,
  Copilot and OpenAI processes/servers.

Adapter contract cases include lifecycle, cancellation, queue/steer/redirect,
model/reasoning persistence, quota emission, reopen, deletion, terminal state and
error normalization.

### Packaging and supply chain

- Validate the VSIX against an allowlist.
- Reject TypeScript sources, backup files and duplicate host modules in the VSIX.
- Maintain size budgets for `extension.js`, webview JS/CSS and the complete VSIX.
- Pin release tools and GitHub Actions to reviewed versions/digests.
- Validate every release credential before the first irreversible publication.
- Generate checksum and provenance metadata for release artifacts.

## Phases

### Phase 1 — Make existing protections real

- [x] Add this plan.
- [x] Introduce one `verify` command.
- [x] Run build CI on `develop`, `main` and pull requests targeting either branch.
- [x] Make release CI run the same verification command.
- [x] Add configuration, i18n, repository and package-content checks.
- [x] Fix confirmed configuration/i18n defects.
- [x] Remove simple `ui -> extension.ts` logger cycles.
- [x] Remove safe legacy artifacts and correct bundle cleanup.

Acceptance: clean repository, all checks green, generated VSIX passes its content
allowlist, and every new guardrail has a regression fixture or self-test.

#### Phase 1 implementation result

- `npm run verify:package` passes end to end.
- ESLint and both extension-host and strict webview typechecks pass.
- All 385 tests pass.
- The existing 400-line hard limit passes for every source file.
- Static configuration checks cover 91 `symposium.*` keys.
- EN and PT-BR dictionaries both contain 386 matching keys.
- The architecture ratchet covers 277 production modules, with six known cycles
  and two known unreachable modules. New or expanded exceptions fail CI.
- The initial large UI/extension cycle was broken through dependency injection
  and direct leaf-contract imports.
- Safe duplicate compression code, legacy voice-extension builds and the tracked
  `.old` file were removed.
- The generated VSIX is constrained to an exact 22-file allowlist and is 378,782
  bytes in the validated Phase 1 build.
- Release tooling is pinned locally, all credentials are checked before
  publication, and `npm audit` reports zero vulnerabilities.
- Full Prettier enforcement remains the explicit Phase 2 migration described
  above; it is the only target verification item not yet blocking CI.

### Phase 2 — Close the architecture boundaries

- [ ] Move `ChatController` out of UI into application/session orchestration.
- [ ] Move shared model selection out of `extension/`.
- [ ] Break the six remaining dependency cycles.
- [ ] Migrate the Prettier baseline and add `format:check` to `verify`.
- [ ] Introduce ports for VS Code state, secrets, process execution and clocks.
- [ ] Consolidate compression namespaces and remove unreachable modules.
- [ ] Update `ARCHITECTURE.md` to match the implemented tree.

Acceptance: zero import cycles; dependency-matrix check has no baseline exceptions.

### Phase 3 — Type the browser boundary

- [ ] Make webview TypeScript strict.
- [ ] Replace webview `any` state with explicit models.
- [ ] Close `HostToWebview`.
- [ ] Introduce typed post-message wrappers and exhaustive dispatch.
- [ ] Eliminate inline raw-JS configuration templates where feasible.

Acceptance: strict webview typecheck with no broad `any` escape hatch and complete
protocol contract coverage.

### Phase 4 — Integration and truthful coverage

- [ ] Add all-source coverage.
- [ ] Add Extension Host tests for activation, commands, configuration and storage.
- [ ] Add DOM tests for sessions, composer drafts/attachments, model selector,
  deletion, usage and error states.
- [ ] Add fake-adapter contract tests.
- [ ] Convert source-inspection tests to behavioral tests.

Acceptance: all critical user journeys have integration coverage and the coverage
report includes every production module.

### Phase 5 — Complexity burn-down

- [ ] Split handlers above 80 lines by command/use case.
- [ ] Reduce every function below complexity 15.
- [ ] Remove file-size exceptions.
- [ ] Reduce the warning threshold from 300 toward 250 lines where practical.

Acceptance: no complexity or size baseline remains.

## Delivery discipline

Each phase must remain releasable and pass `npm run verify`. Architectural checks
start as ratchets when existing debt prevents a zero-tolerance rule. Every ratchet
stores exact exceptions, rejects growth, and is removed in the next applicable
phase; generic directory-wide exemptions are not allowed.
