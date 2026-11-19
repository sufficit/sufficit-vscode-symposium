# Chat webview split — complete (chatClient.ts → 19 modules + esbuild)

**Date:** 2026-06-22 · **Version:** 0.79.184

## Outcome
`src/ui/chatClient.ts` went from a **2764-line untyped string blob** (one injected `<script>`) to a **13-line bundle reader**, with the client authored as **19 typed ES modules** under `src/ui/webview/`, bundled by **esbuild**. Every webview source file is now **≤400 lines** — the size-guard exemption for `index.ts`/`chatClient.ts` is removed.

## Modules (final sizes)
```
dispatch 377 · panels 342 · index 306 · menus 251 · composer 235 · messages 228
sessions 214 · markdown 203 · tools 186 · statusbar 130 · status 74 · icons 71
models 65 · state 63 · boot 59 · scroll 54 · format 46 · dom 41 · vscode 10
```

## Architecture
- **Foundation (L0/L1):** `vscode` (single `acquireVsCodeApi` + `saved`/`saveState`), `dom` (typed element refs), `state` (shared mutable state via live-binding `export let` + setters), `scroll`, `format`, `icons`, `markdown`.
- **Features:** `menus`, `models`, `status` (setStatus hub), `sessions`, `boot`, `composer`, `messages`, `tools`, `panels`, `statusbar`.
- **`dispatch`** registers the inbound message handler; **`index`** is the thin entry (DOM listeners + init).
- The feature cluster (composer↔messages↔tools↔panels↔statusbar) uses **cyclic ES-module imports** — safe because they call each other's *functions* (only init-time value access breaks under cycles).
- `chatClient.ts` reads `out/ui/webview.bundle.js`; `chatHtml.ts` injects it inline unchanged (nonce/CSP identical).

## Build/verification
- `build:webview` (esbuild) → `out/ui/webview.bundle.js`; `compile` = `clean && tsc && build:webview` (the `clean` step prevents stale orphan shadowing — see the 0.79.177 fix).
- `tsconfig.webview.json` (DOM lib) for `typecheck:webview`; `webview.d.ts` declares `acquireVsCodeApi`.
- Each extraction verified: esbuild + `node --check` bundle + `typecheck:webview` (0 missing-name `TS2304`) + **jsdom harness** (`scripts/wv-harness.cjs`, loads the real HTML+bundle to catch load-time throws) + 49 unit tests.
- Shipped incrementally (0.79.178→0.79.184), installed local + development code-server, rollback `0.79.174`.

## Caveat
The jsdom harness verifies **load-time** only, not clicks. Interactive paths (send/edit/slash/paste, tool rows, panels, pickers) were validated by the user post-install at each shipped increment.

## Follow-ups
`chatStyles.ts` (1133, CSS blob) and the host-side `chatSurface.ts`/`chatController.ts`/`openai/session.ts` remain exempt — same split pattern applies.
