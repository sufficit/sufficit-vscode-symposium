# Integration and truthful coverage

Status: **Completed**
Date: 2026-08-07

## Activity

Added whole-host coverage, behavioral browser tests, a shared adapter contract
and a real VS Code Extension Host integration suite.

## Implemented

- added `c8 --all` coverage over every compiled production module, including
  modules never loaded by unit tests;
- established the first honest ratchet at 39% statements/lines, 56% functions
  and 66% branches;
- added an 85% changed-executable-line gate for pull requests;
- added jsdom tests against the real bundled webview and shared chat markup;
- covered per-session composer drafts and attachments, model restoration,
  session deletion, usage rendering, non-fatal errors and local continuation;
- added one reusable lifecycle contract exercised by real Claude, Codex and
  Copilot session implementations through a deterministic fake CLI;
- exercised the OpenAI-compatible implementation through a deterministic local
  HTTP/SSE server;
- removed eager VS Code runtime loading from adapter definition/catalog paths;
- added Extension Host tests for activation, every contributed command,
  configuration defaults and workspace configuration persistence;
- added the Extension Host suite to build CI under `xvfb-run` and pinned the
  tested minimum VS Code version to 1.100.3.

## Validation

- unit/contract/DOM suite: 394 tests, zero failures;
- whole-source coverage ratchet: pass;
- Extension Host 1.100.3 activation suite: pass;
- deterministic fake adapters: Claude, Codex, Copilot and OpenAI all pass;
- dependency audit after test tooling installation: zero vulnerabilities.

## Outcome

Coverage no longer hides unimported production modules. The most failure-prone
browser journeys and adapter lifecycle now execute behaviorally, while activation
and manifest registration are verified inside VS Code rather than inferred from
source text.
