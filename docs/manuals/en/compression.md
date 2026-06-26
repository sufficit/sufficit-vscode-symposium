# Compression Manual

## Overview

Symposium's compression system reduces token usage by compressing conversation history before sending to the LLM. This allows longer conversations without hitting context limits.

## Compression Tab

Access via **Symposium Settings → Compression**

### Auto-compaction

**Auto-compact threshold** - Triggers automatic compression when context reaches:
- Disabled (0%) - Manual compression only via `/compact`
- 60-90% - Compress when reaching this % of model's context window

**Max history messages** - Limits recent messages sent per request:
- Unlimited (0) - Send all messages
- 20-200 - Keep only N most recent messages
- System/developer prompts preserved separately

### Turn Limits

**Step limit per turn** - Max tool calls before pausing for "continue":
- 10-200 steps
- Ignored in autonomous mode (Away presence)

**Stop if no reply** - Anti-loop protection:
- Stops after N tool steps with no assistant text
- Unlimited (0) - Never auto-stop

## Compression Presets

Presets define **how** to compress messages when limits are hit.

### Built-in Presets

**None** - No compression, full history
- Use: Short sessions, debugging, reviewing full context

**Summarize** - Keeps recent messages, summarizes old
- Default: 10 recent messages
- Use: Balanced - most conversations

**Aggressive** - Maximum compression
- Keeps only 5 recent messages
- Use: Long sessions, low token budget

**Token Budget** - Compresses to fit token limit
- Default: 4000 tokens
- Use: Models with small context windows

### Custom Presets

**Create New Preset**:

1. **Name** - Descriptive name (e.g., "Deep Debugging")
2. **Description** - When to use this preset
3. **Strategy** - Compression algorithm:
   - `none` - No compression
   - `summarize` - Keep N recent
   - `aggressive` - Keep 5 recent
   - `token-budget` - Fit under token limit
4. **Strategy Params**:
   - `summarize`/`aggressive`: **Messages to keep** (1-100)
   - `token-budget`: **Max tokens** (500-200000)
5. **Tool Compression Level**:
   - `none` - Full tool requests in history
   - `low` - Remove server-resolved headers (contextId, sessionId)
   - `medium` - Compact to action hints ("saved task")
   - `high` - Remove already-processed tool calls

**Edit Preset** - Click edit button to modify all params

**Delete Preset** - Remove custom presets (built-ins protected)

**Set Default** - Default preset for new sessions

## Tool Request Compression

Separate from message compression - reduces **tool call arguments** in history:

### Compression Levels

**Low** - Removes redundant fields:
- `contextId`, `sessionId` (server already has them)
- `source` headers
- Saves ~10-20 tokens per tool call

**Medium** - Compacts to hints:
```json
// Before
{ "type": "memory_save", "title": "Task X", "summary": "...", "payload": "{...}" }

// After (medium)
{ "_compressed": true, "action": "saved task-anchor", "title": "Task X" }
```
Saves ~80-200 tokens per save

**High** - Removes processed calls:
- Tool calls already executed → removed from history
- Only errors/failures kept
- Saves ~100% of successful tool tokens

### Supported Tools

Currently compressed:
- `memory_save` / `mcp__Sufficit_AI__memory_save`
- `memory_search` / `mcp__Sufficit_AI__memory_search`
- `memory_get_observations` / `mcp__Sufficit_AI__memory_get_observations`

More tools will be added based on usage patterns.

## Two-Stage Compression Pipeline

When sending messages to LLM:

**Stage 1: Tool Request Compression**
- Compresses individual tool call inputs
- Applied based on preset's `toolCompressionLevel`

**Stage 2: Message-Level Compression**
- Applies preset strategy (summarize/aggressive/token-budget)
- Removes/summarizes old messages

## Per-Session Overrides

Change compression mid-conversation:

1. Click compression selector in chat UI
2. Pick preset for this session
3. Applies immediately to next message
4. Saved in session state (survives reopens)

## Settings Storage

- **Presets**: `symposium.compression.presets` (global)
- **Default**: `symposium.compression.defaultPreset`
- **Per-session**: `symposium.compression.sectionConfigs`

## Best Practices

**Short sessions (< 20 messages)**: Use `none`
- Full context aids debugging
- Low token cost anyway

**Normal development**: Use `summarize` (default)
- Keeps 10 recent messages
- Summarizes history efficiently

**Long debugging sessions**: Create custom preset
- Strategy: `summarize`
- Keep: 20 messages
- Tool level: `medium`

**Token-constrained models**: Use `token-budget`
- Set limit to 70% of model's window
- Leaves room for tools + response

**Memory-heavy workflows**: Enable tool compression
- Level: `medium` or `high`
- Saves 60-80% tokens on memory operations

## Troubleshooting

**"Context too long" errors**:
1. Lower auto-compact threshold (70% → 60%)
2. Reduce max history messages (40 → 20)
3. Use more aggressive preset
4. Enable tool compression (medium/high)

**Lost important context**:
1. Increase messages to keep in preset
2. Use `/compact` manually (preserves in ledger)
3. Use `read_session` tool to recover full history

**Compression not working**:
1. Check preset is not `none`
2. Verify auto-compact threshold > 0
3. Check session didn't override to `none`
4. Look for compression diagnostics in usage events
