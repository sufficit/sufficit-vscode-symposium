# Compression implementation

The OpenAI-compatible adapter has three history controls. They operate at
different stages of a request.

| Control | Implementation | Behavior |
| --- | --- | --- |
| Request window | [Context policy](../../src/adapters/openai/contextPolicy.ts) and [request window](../../src/adapters/openai/requestWindow.ts) | Selects messages for a request. The ledger retains the original transcript. |
| Conversation compaction | [Compactor](../../src/adapters/openai/compactor.ts) | Asks the configured backend to summarize history and retains a recent tail in live context. The adapter intercepts `/compact` locally. |
| Request compression preset | [Turn compression](../../src/adapters/openai/turnCompression.ts) and [strategies](../../src/compression/webhook.ts) | Applies a deterministic transformation when the session options supply a preset. The `summarize` strategy inserts a short count-based notice and retains recent messages. |

The [preset manager](../../src/compression/manager.ts) reads the built-in
presets from [the catalog](../../src/compression/types.ts) and stores custom
presets and selections in VS Code configuration under `symposium.compression`.
Its default preset ID is `none`. The configuration panel exposes preset
editing. To verify a preset affects requests, check that the session passes
`compressionPresetId` to the adapter. A saved selection alone does not
establish that this happened.

`token-budget` uses an estimate of one token per four characters and tries
at most five reductions. The provider's context limit still applies.
`expandStartToToolBoundary` adjusts the retained slice to keep tool calls
and results together. A missing preset falls back to the unchanged request
and emits a notice.

## Tests

The [compactor tests](../../src/test/compactor.test.ts) cover summary behavior
and recovery. The [context policy tests](../../src/test/contextPolicy.test.ts)
cover request selection and omission notices. The
[configuration tests](../../src/test/contextSettings.test.ts) cover persisted
settings and defaults.

Run the repository suite with `npm test`. Read the
[user guide](../guides/context-and-history.md) for the supported controls.
