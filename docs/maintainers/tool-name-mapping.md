# Tool-name mapping boundaries

Tool names cross three independent boundaries. They must not be treated as one
global rename system because each boundary has a different owner and lifetime.

## 1. VS Code LM-tool registry — owned by Symposium

`src/adapters/lmTools.ts` bridges dynamically registered `vscode.lm.tools` into
the OpenAI function-tool protocol. A VS Code extension may expose a name that
contains characters forbidden by that protocol or exceeds its 64-character
limit. Symposium therefore creates a protocol-safe alias and retains the
reverse mapping locally:

```text
VS Code registry name -> protocol-safe alias -> sufficit-ai/provider
VS Code invocation    <- registry name       <- returned alias
```

Only Symposium can perform the last step because only the extension host owns
`vscode.lm.tools` and can call `vscode.lm.invokeTool`. The backend must treat the
alias as the tool's exact public name. This mapping is rebuilt from the live
registry for each use; it is not provider state and is not a singleton cloak.

Symposium-native tools such as `shell`, filesystem tools, memory tools and
subagent tools do not use this map. Collision prefixes applied by
`openai/toolMerge.ts` are likewise local dispatch aliases and are stripped
before local execution.

## 2. Anthropic protocol compatibility — owned by sufficit-ai

The generic Anthropic adapter transports the names received from its client.
It must not apply Claude Code fingerprint aliases. A separate dispatcher
middleware may shorten names that exceed Anthropic's protocol ceiling, retaining
the reverse map in the dispatch context.

## 3. Claude first-party compatibility — owned by the Claude adapter

The Claude connector may cloak third-party tool names to the canonical names
used by Claude Code. That mapping is per request and bidirectional, including
structured streaming deltas. It must not leak into the generic Anthropic
adapter or into Symposium's VS Code registry bridge.

## Invariant

Every mapping is reversed by the same layer that created it:

- Symposium aliases VS Code registry names and restores them before local
  invocation.
- The sufficit-ai dispatch middleware restores any protocol-length alias.
- The Claude adapter restores its fingerprint alias before returning a tool
  call or streaming delta.

If a lower layer receives a name it did not map, it passes that name through
unchanged.
