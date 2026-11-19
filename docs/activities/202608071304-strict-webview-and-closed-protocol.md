# Strict webview and closed protocol

Status: **Completed**
Date: 2026-08-07

## Activity

Completed the browser-client type-safety migration and made the host/webview
message boundary an executable contract.

## Implemented

- enabled full TypeScript strict mode for the webview project;
- removed every explicit `any` from browser production modules;
- introduced shared types for persisted UI state, sessions, models, tools,
  panels, usage and voice APIs;
- closed the host-to-webview discriminant over a single canonical message list;
- added a contract test that rejects host messages without a browser receiver;
- fixed the missing `compression-preset-set` receiver discovered by that test;
- fixed protocol drift in session backend and editor-opening actions;
- made the raw VS Code API handle private and routed all outbound browser
  messages through a typed `postMessage` wrapper;
- included browser TypeScript in ESLint and fixed all blocking async findings;
- kept the PWA transport API compatible with the typed VS Code transport.

## Validation

- strict webview TypeScript: pass;
- extension-host TypeScript: pass;
- ESLint including webview: pass;
- VS Code webview bundle: pass;
- PWA bundle: pass;
- focused protocol, system-notice and markdown tests: 13 pass, zero failures.

## Outcome

Browser messages can no longer silently introduce arbitrary discriminants, and
outbound calls cannot bypass the shared protocol type. Protocol drift is now a
CI-visible failure instead of a runtime-only defect.
