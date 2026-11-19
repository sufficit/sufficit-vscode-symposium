# Activity — executable engineering and architecture guardrails

**Status:** complete
**Implemented:** 2026-08-07 in commit `df00642`

## Outcome

Important repository conventions became executable CI contracts. Existing
architecture debt is represented by exact ratchets, so it cannot grow silently.

## Implemented scope

- Added static checks for all literal `symposium.*` configuration reads and
  writes against the extension manifest.
- Enforced exact EN/PT-BR configuration dictionary parity and detected
  Portuguese contamination in English values.
- Rejected tracked `.old`, `.bak` and `.orig` artifacts.
- Added a TypeScript-AST import graph with exact cycle, boundary and unreachable
  module baselines.
- Kept the existing 400-line source limit in the main test contract.

## Verified baseline after implementation

- 91 configuration keys checked.
- 386 EN and 386 PT-BR strings checked.
- 277 production modules analyzed.
- Six known cycles and two known unreachable modules, with growth rejected.
- Zero dependency vulnerabilities after the development-tool updates.
