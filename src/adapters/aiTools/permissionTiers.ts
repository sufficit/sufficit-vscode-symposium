/**
 * Tool-tier classification + the unified permission-mode vocabulary
 * (admin/manager/user/plan), shared across every adapter's picker.
 *
 * Real in-process enforcement (deciding whether a tool call may run
 * immediately or needs an inline approval) exists today only for the openai
 * adapter (native "Sufficit AI" + custom OpenAI-compatible backends) — the
 * one adapter where Symposium, not an external CLI, executes each tool call.
 * claude/codex/copilot run tools inside their own CLI process; see each
 * adapter's permissionModes()/defaultPermission() for how they map onto this
 * same vocabulary using native flags where possible.
 */

export type ToolTier = "read" | "write" | "destructive";

/** Never mutates anything; always safe, in every mode including "user". */
const READ_TOOLS = new Set([
    "memory_search",
    "memory_get_observations",
    "list_tasks",
    "web_search",
    "read_file",
    "list_dir",
    "fetch_url",
    "open_url",
    "read_session",
    "get_workspace_bootstrap",
    "list_agents",
    "agent_status",
]);

/** Irreversible or arbitrary-execution: gated even in "manager" mode. */
// Guardrails alter every later turn in the session. Treat both creation and
// removal as durable policy changes, so manager mode still asks for approval.
const DESTRUCTIVE_TOOLS = new Set(["shell", "add_guardrail", "clear_guardrails", "agent_stop"]);

/**
 * Bridged VS Code Language Model tools (runInTerminal/runTask/runTests/
 * browser navigation, selected via symposium.lmTools) are arbitrary external
 * capabilities Symposium can't inspect — anything that reads as command/
 * terminal execution is treated as destructive; everything else bridged
 * defaults to write, never silently read-only.
 */
const LM_DESTRUCTIVE_PATTERN = /terminal|exec|shell|command/i;

/** Classifies one of Symposium's own tools (aiTools/defs.ts, localDefs.ts, subagentDefs.ts). */
export function classifyTool(name: string): ToolTier {
    if (READ_TOOLS.has(name)) {
        return "read";
    }
    if (DESTRUCTIVE_TOOLS.has(name)) {
        return "destructive";
    }
    return "write";
}

/** Classifies a bridged VS Code Language Model tool by name heuristic. */
export function classifyLmTool(name: string): ToolTier {
    return LM_DESTRUCTIVE_PATTERN.test(name) ? "destructive" : "write";
}

/** Unified permission modes, same 4 labels offered by every adapter's picker. */
export type PermissionMode = "admin" | "manager" | "user" | "plan";

export const PERMISSION_MODES: PermissionMode[] = ["admin", "manager", "user", "plan"];

/**
 * True when a tool call of this tier must pause for an inline approval under
 * the given mode. Plan mode never prompts here — it hard-blocks write/
 * destructive tools outright (see localRun.ts), so nothing reaches this check.
 */
export function needsApproval(mode: string | undefined, tier: ToolTier): boolean {
    switch (mode) {
        case "user":
            return tier !== "read";
        case "manager":
            return tier === "destructive";
        default:
            return false; // "admin", "plan", unset
    }
}
