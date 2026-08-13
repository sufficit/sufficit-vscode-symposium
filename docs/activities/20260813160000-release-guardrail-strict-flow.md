# Strict release guardrail

Status: **Completed**
Date: 2026-08-13

## Activity

Transform the required release sequence into a machine-checked guardrail:

`version → verify:package → commit on develop → push → annotated tag → CI → installation`.

## Delivered

- strict release validation for version format and synchronized lockfile;
- rejection of releases prepared from a non-`develop` branch;
- detached-tag validation against `origin/develop`;
- rejection of a version that is not newer than the latest release tag;
- validation that the release ref is an annotated tag pointing to `HEAD`;
- publication workflow wired to the shared guardrail instead of a duplicated
  shell check;
- release procedure documented in `docs/RELEASE.md`.

## Outcome

Every release now has the same enforceable preconditions locally and in CI.
