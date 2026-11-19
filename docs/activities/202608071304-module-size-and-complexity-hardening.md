# Module size and complexity hardening

Status: **Completed**
Date: 2026-08-07

## Activity

Decomposed every source module that exceeded the hard size contract and made
function size and estimated decision complexity continuously measurable.

## Implemented

- removed the file-size exception mechanism: every TypeScript source file is now
  subject to the same 400-line hard limit;
- split the large extension-host, bridge, controller, OpenAI, Claude, AI-tool,
  configuration, surface, webview, PWA and voice modules into focused owners;
- kept compatibility seams where tests and adapter APIs intentionally depend on
  a stable method, delegating the implementation to the extracted collaborator;
- added an AST-based complexity inventory with targets of 80 lines per function
  and 15 estimated decisions;
- added `check:complexity:strict` as the zero-tolerance form of that check;
- kept the regular CI inventory free of named baselines and permanent exception
  lists, so every remaining target is visible instead of silently grandfathered;
- realigned UI contract tests with the new module owners and retained behavioral
  DOM coverage for the critical user journeys.

## Validation

- hard source-size contract: zero files above 400 lines;
- unit, contract and DOM suite: 394 tests, zero failures;
- advisory refactor inventory: 54 files above 300 lines and 148 function targets;
- no source file, function or namespace has an individual exemption entry.

## Outcome

The project can no longer reintroduce oversized source files. Complexity debt is
now explicit and queryable through one deterministic AST check, with a strict
command available for progressive burn-down, instead of being hidden behind an
exception baseline. The extracted modules also isolate future reductions to
smaller responsibilities without another broad rewrite.
