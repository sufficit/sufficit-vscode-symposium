# Feature versioning

Symposium versions each public capability independently from the extension package. This lets
plugins, adapters, remote clients, and other developers compare contracts without assuming that
two installations with different package releases expose different feature behavior.

## Contract

Every feature owns two exports in a `feature.ts` file inside its namespace:

```ts
import { defineFeature } from "../features/definition";

export const EXAMPLE_FEATURE_VERSION = "1.0.0";

export const EXAMPLE_FEATURE = defineFeature({
    namespace: "symposium.example",
    version: EXAMPLE_FEATURE_VERSION,
    description: "Public example capability.",
});
```

The version is semantic and independent from `package.json`. A package release can change without
changing every feature. When a feature changes:

- patch: compatible corrections that do not alter the public contract;
- minor: backward-compatible additions;
- major: incompatible contract or behavior changes.

For features below `1.0.0`, a different minor version is treated as incompatible. The helper
`isFeatureVersionCompatible()` implements this rule.

Internal layers such as `application`, `infrastructure`, and `protocol` do not receive versions of
their own. They inherit the version of the public feature that owns their behavior.

## Catalog and discovery

`src/features/catalog.ts` is the immutable central registry. It exports:

- `SYMPOSIUM_FEATURES`: definitions with namespace, version, and description;
- `SYMPOSIUM_FEATURE_VERSIONS`: a stable `namespace -> version` map;
- `SymposiumFeatureNamespace`: the union of registered namespace literals.

`src/features/index.ts` also re-exports every named feature constant. In-process consumers can use
one stable import surface while each constant remains physically owned by its feature namespace.

The map is available through all public discovery surfaces:

- extension API: `activate()` result, under `api.features`;
- HTTP discovery: `/.well-known/symposium.json`, under `features`;
- OpenAPI: `/openapi.json`, under `info.x-symposium-feature-versions`.

Consumers should compare the required feature namespace directly and use
`supportsFeatureVersion()` when running in-process. They must not infer feature compatibility from
the extension package version.

## Registered namespaces

| Namespace | Owner |
| --- | --- |
| `symposium.adapter.claude` | Claude adapter |
| `symposium.adapter.codex` | Codex adapter |
| `symposium.adapter.copilot` | Copilot adapter |
| `symposium.adapter.openai-compatible` | OpenAI-compatible and Sufficit AI adapter |
| `symposium.adapters` | Shared adapter contract |
| `symposium.ahp` | Agent Host Protocol |
| `symposium.ai-tools` | AI tool discovery and execution |
| `symposium.api` | Public API and discovery |
| `symposium.auth` | Authentication and credentials |
| `symposium.changesets` | AHP change sets |
| `symposium.chat-ui` | Chat user interface |
| `symposium.client-tools` | AHP client tools |
| `symposium.compression` | Context compression |
| `symposium.configuration` | Settings and presets |
| `symposium.customizations` | AHP customizations |
| `symposium.pwa` | Progressive web application |
| `symposium.recovery` | Bounded transient-failure recovery |
| `symposium.relay` | Relay and remote transport |
| `symposium.resources` | AHP resources |
| `symposium.scm` | Source control integration |
| `symposium.sessions` | Session lifecycle and persistence |
| `symposium.sync` | State synchronization |
| `symposium.telemetry` | AHP telemetry |
| `symposium.terminal` | AHP terminal |
| `symposium.voice` | Audio capture and transcription |

## Adding or changing a feature

1. Add or update the namespace's `feature.ts` constant and definition.
2. Export `./feature` from the namespace barrel when an `index.ts` exists.
3. Register the definition in `src/features/catalog.ts` in namespace order.
4. Re-export the named constants from `src/features/index.ts`.
5. Update any legacy protocol identifier that mirrors the feature version.
6. Add compatibility tests and run `npm run check:engineering`.

The engineering guardrail rejects malformed versions, duplicate namespaces, missing catalog
entries, mismatched constants, missing descriptions, and missing barrel exports.
