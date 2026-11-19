# Feature namespace versioning

Status: **FINALIZED** (2026-08-31)

## Objective

Give every independently consumable Symposium feature a stable namespace and its own semantic
version, so plugins and external developers can export, discover, and compare capabilities without
coupling them to the extension package release.

## Delivered

- Added the validated feature contract and semantic compatibility helpers in `src/features`.
- Registered 25 immutable feature definitions and version constants in their owning namespaces,
  including the independently versioned transient-recovery capability.
- Re-exported all named constants through one stable feature API for external developers.
- Replaced duplicate API and AHP version literals with their canonical feature constants.
- Exposed the complete version map through the extension API, discovery document, and OpenAPI.
- Added tests for catalog completeness, ordering, immutability, semantic compatibility, discovery,
  and legacy protocol alignment.
- Extended the engineering guardrail to enforce namespace uniqueness, strict semantic versions,
  catalog coverage, descriptions, canonical constants, and barrel exports.
- Documented the public contract and contribution workflow in `docs/FEATURE-VERSIONING.md`.

## Architectural decision

Only public, substitutable, negotiable, or externally consumed capabilities are independently
versioned. Internal implementation layers inherit the version of their owning feature. This keeps
the registry useful for plugin-style compatibility checks instead of turning every source folder
into a public contract.

The extension package version remains a release identifier. It is not a compatibility proxy for a
feature.

## Verification

- `npm run typecheck`
- `npm run check:engineering`
- directed feature and bridge unit tests
- full repository test, lint, architecture, and build gates

## Release

Shipped in `v2026.831.1`.
