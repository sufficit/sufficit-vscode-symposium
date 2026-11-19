# Activity — release packaging and supply-chain hardening

**Status:** complete
**Implemented:** 2026-08-07 in commit `df00642`
**Release:** [v2026.807.1](https://github.com/sufficit/sufficit-vscode-symposium/releases/tag/v2026.807.1)

## Outcome

The published extension is generated from an explicit package allowlist and the
release cannot begin publishing with incomplete credentials.

## Implemented scope

- Pinned VSCE and Open VSX release tools as development dependencies.
- Updated esbuild and vulnerable transitive dependencies.
- Made bundling remove newly introduced compiled namespaces automatically.
- Removed legacy voice-extension sources and prebuilt copies.
- Added exact VSIX path and size budgets.
- Validated all publishing credentials before the first marketplace write.
- Attached the generated VSIX to the GitHub release.

## Validation and deployment

- VSIX allowlist: 22 files.
- Validated local artifact SHA-256:
  `59c6c64fca71ce6410db7486fc92a1e9c2bfb84776fcb99736a6899438513f35`.
- Installed and verified `2026.807.1` in desktop VS Code and the development
  code-server.
- Visual Studio Marketplace, Open VSX and GitHub Release publication succeeded.
