# Native subagent tools (spawn + control, background/foreground)

**Date:** 2026-06-22 · **Version:** 0.79.175

## Problem

The Sufficit AI agent could not use subagents — there was no spawn/delegate tool
in the native (openai) backend. An "agent" was only a session persona a human
started via `symposium.newAgentSession`; nothing let the model delegate mid-turn.
The only "subagent" ever seen (`explore_subagent`) was Copilot's bridged LM tool
(now blocked). Separately, on the `development` code-server, agent-defs never
synced because `symposium.hub.url` was unset (config-only; auto-pull gate at
`extension.ts` no-ops when the hub isn't configured).

## What shipped

Subagents are now real `ChatController` sessions spawned through the existing
`LiveSessions` runtime, exposed to the model via a late-bound `SubagentHost`
injected into `ToolContext` (mirrors the `setOpenAITokenProvider` pattern — no
layering cycle). This reuses all session machinery: any backend, persistence,
sessions-list visibility, and `subscribe`/`interrupt` control.

### Tools (native Sufficit AI backend)
- `spawn_agent { agent, task, background?, backend?, model? }` — foreground
  (blocks, returns final output) or background (returns id immediately).
- `list_agents`, `agent_status { id }`, `agent_send { id, text }`, `agent_stop { id }`.

Exposed only when the runtime host is set. For bound agent-defs, an
`agents`/`spawn`/`orchestrate`/`subagent`/`delegate` capability token enables them
(`aiToolsForAgent`).

### Backend/model resolution
`spawn_agent` arg → agent-def frontmatter (`backend:` new field, `model:` existing)
→ inherit parent conversation backend. If a def declares a constraint (name,
comma-list, or wildcard like `gpt-*`), the resolved value must match or the spawn
is rejected. Helper: `matchWildcard` / `matchAny` in `src/sessions/subagents.ts`.

### Guards
Max depth 2, max concurrent 4, output buffer 30k, foreground wait
`symposium.subagents.timeoutMs` (default 300000; past it the run continues in the
background and the partial result is returned). Disallowed in plan mode.

### Visibility (collapsible tree)
Subagents carry `parentId` (`SessionInfo` + `SessionStartOptions` + `liveInfos` +
`ChatController.parentId`); the sessions list nests them under their parent with a
caret toggle, collapsed-state persisted in webview state.

## Files
- New: `src/sessions/subagents.ts` (`SubagentManager`), `src/adapters/aiTools/subagentDefs.ts`.
- Edited: `src/adapters/aiTools/{types,defs,run,index}.ts`, `src/adapters/openai/session.ts`,
  `src/adapters/types.ts`, `src/sessions/runtime.ts`, `src/ui/chatController.ts`,
  `src/ui/chatClient.ts`, `src/config/root.ts`, `src/extension.ts`, `package.json`.

## Verification
`tsc` clean · `check:webview` ok · `check:size` ok (defs.ts split to stay <400) ·
49 tests pass · eslint + prettier clean.

## Follow-ups
- Subagents persist to disk; on reload they lose `parentId` (tree is live-only) — acceptable for v1.
- Optional: default `symposium.hub.url` + a visible "hub not configured" banner so a fresh machine always syncs.
