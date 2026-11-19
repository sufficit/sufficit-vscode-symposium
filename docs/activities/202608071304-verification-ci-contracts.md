# Activity — unified verification and CI contracts

**Status:** complete
**Implemented:** 2026-08-07 in commit `df00642`
**Released:** `v2026.807.1`

## Outcome

Local development, pull requests, branch builds and releases now use the same
verification path instead of maintaining partially duplicated command lists.

## Implemented scope

- Added `npm run verify` for lint, host/webview typechecks, tests, guardrails
  and the production build.
- Added `npm run verify:package` for the complete verification plus VSIX
  generation and content validation.
- Enabled build CI for `develop`, `main` and pull requests targeting either
  branch.
- Made the release workflow execute the same verification contract.
- Added workflow concurrency controls and read-only default permissions.

## Validation

- 385 tests passed.
- ESLint and both TypeScript projects passed.
- The `develop` build and `v2026.807.1` release workflows completed
  successfully.
