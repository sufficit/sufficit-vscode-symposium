# Architecture boundaries and formatting

Status: **Completed**
Date: 2026-08-07

## Activity

Closed the Phase 2 architecture boundaries and migrated the complete TypeScript
source tree to the repository's Prettier contract.

## Implemented

- moved dialogue orchestration from `ui/` to `application/`;
- moved shared model selection from `extension/` to `application/`;
- moved shared host/browser contracts to `protocol/`;
- introduced environment ports and a VS Code infrastructure implementation;
- removed all six remaining relative-import dependency cycles;
- removed the dead Claude model module and made AHP channel storage an explicit
  supported entrypoint;
- emptied the architecture exception baseline;
- added extension-host typechecking and formatting to `npm run verify`;
- updated `ARCHITECTURE.md` to describe the implemented dependency direction;
- made source-inspection tests resilient to formatter whitespace.

## Validation

- Prettier check: pass;
- ESLint: pass;
- extension-host TypeScript: pass;
- webview TypeScript: pass;
- architecture: 282 production modules, zero cycles, zero unreachable modules,
  zero boundary exceptions;
- unit suite: 385 tests.

## Outcome

The architecture rules are now executable with no cycle, boundary or reachability
baseline. Application orchestration no longer imports VS Code directly.
