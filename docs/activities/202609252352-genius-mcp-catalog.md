# Genius MCP catalog handoff from Symposium

## Objective and starting state

The native Genius adapter already supplied delegated authentication, preset discovery, context usage, and session deletion. Symposium's MCP repository was not available to Genius turns. Issue #65 extends the existing adapter PR #60.

## Changes and decision

Each `genius exec` child receives a fresh `GENIUS_CLI_MCP_SERVERS_JSON` declaration built from Symposium's managed stdio and remote MCP manifests. The built-in Sufficit MCP identity is excluded because Genius already owns it. Stdio servers use the dialogue workspace as their working directory. The adapter clears any inherited declaration for other CLI queries and replaces it for each turn. Genius uses its own lazy catalog to discover and choose tools; Symposium does not attach tool schemas to prompts.

The adapter contract is documented in `docs/GENIUS-CLI-ADAPTER.md`. The extension version is 2026.925.7.

## Validation and delivery

- Converter and fake CLI handoff tests passed, including built-in exclusion, stdio/HTTP conversion, delegated bearer, and stale environment replacement.
- `COVERAGE_BASE_SHA=$(git merge-base origin/develop HEAD) npm run verify:package` passed, including lint, type checks, tests, changed-line coverage, VSIX packaging and allowlist.
- VSIX `2026.925.7` was installed on the development code-server and its installed version was confirmed. The resident Genius CLI is `0.128.0`, active, with its existing session accessible.
- Genius's published CLI reported the fixture MCP tool in its catalog and completed a direct test turn. The resident-pipe handoff was also exercised with an isolated fixture.

Review: [PR #60](https://github.com/sufficit/sufficit-vscode-symposium/pull/60), companion [Genius PR #1002](https://github.com/sufficit/sufficit-ai-genius/pull/1002).

An already open code-server window must reload before its extension host uses version 2026.925.7. No authenticated live turn from that window was run; the adapter and native CLI contracts were validated with fake and isolated MCP servers.
