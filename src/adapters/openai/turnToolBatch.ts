import { classifyLmTool, classifyTool, needsApproval } from "../aiTools/permissionTiers";
import { isLmTool } from "../lmTools";
import { diffCounts, editDiff } from "../parse";
import { snapshots } from "../../snapshots";
import { stripSourcePrefix } from "./toolMerge";
import { friendlyToolDetail, toolPath } from "./toolDetail";
import { executeTurnTool } from "./turnTools";
import type { TurnRunnerDeps } from "./turnRunnerDeps";
import type { ChatMessage, ToolCall } from "./types";

interface BatchContext {
    deps: TurnRunnerDeps;
    messages: ChatMessage[];
    progress: string[];
    toolCalls: ToolCall[];
    text: string;
    abortSignal?: AbortSignal;
}

/** Executes and persists one complete model-requested tool batch. */
export async function executeToolCallBatch(context: BatchContext): Promise<boolean> {
    const { deps, messages, progress, toolCalls, text } = context;
    messages.push({ role: "assistant", content: text || null, tool_calls: toolCalls });
    if (text) deps.led("assistant", text);
    deps.safePersist();
    let compactAfterTurn = false;
    for (const call of toolCalls) {
        const args = parseArguments(call.function.arguments);
        const name = stripSourcePrefix(call.function.name);
        emitToolStart(deps, call, name, args);
        const result = await executeOneTool(deps, call, name, args, context.abortSignal);
        deps.emit({ kind: "tool-end", toolName: name, toolId: call.id, result });
        messages.push({
            role: "tool",
            tool_call_id: call.id,
            name,
            content: result,
        });
        const detail = friendlyToolDetail(name, args);
        deps.led("tool", result, { name, detail });
        progress.push((name + (detail ? " — " + detail : "")).slice(0, 110));
        if (progress.length > 60) progress.shift();
        deps.safePersist();
        if (isCompletedTaskTool(name, result)) {
            compactAfterTurn = (await handleCompletedTasks(deps)) || compactAfterTurn;
        }
    }
    return compactAfterTurn;
}

function emitToolStart(
    deps: TurnRunnerDeps,
    call: ToolCall,
    name: string,
    args: Record<string, unknown>,
): void {
    const counts = diffCounts(name, args);
    const editPath = counts ? deps.resolveToolPath(args.path) : undefined;
    if (counts && editPath && deps.sessionId) snapshots.capture(deps.sessionId, editPath);
    deps.emit({
        kind: "tool-start",
        toolName: name,
        detail: friendlyToolDetail(name, args),
        path: editPath ?? toolPath(name, args),
        added: counts?.added,
        removed: counts?.removed,
        diff: editDiff(name, args),
        toolId: call.id,
        input: call.function.arguments,
    });
}

async function executeOneTool(
    deps: TurnRunnerDeps,
    call: ToolCall,
    name: string,
    args: Record<string, unknown>,
    abortSignal?: AbortSignal,
): Promise<string> {
    const tier = isLmTool(name) ? classifyLmTool(name) : classifyTool(name);
    const containment = !!deps.options.allowedWriteRoots?.length;
    const requiresApproval =
        tier !== "read" &&
        (needsApproval(deps.options.permission, tier) ||
            (tier === "destructive" && containment && deps.options.permission !== "admin"));
    if (
        requiresApproval &&
        !(await deps.requestApproval(call.id, name, friendlyToolDetail(name, args), tier))
    ) {
        return JSON.stringify({ error: "User denied this action." });
    }
    return executeTurnTool({
        name,
        input: args,
        toolId: call.id,
        hub: deps.hub,
        options: deps.options,
        sessionId: deps.sessionId,
        backend: deps.backend,
        shellMode: deps.shellExecutionMode(),
        abortSignal,
        emit: deps.emit,
    });
}

async function handleCompletedTasks(deps: TurnRunnerDeps): Promise<boolean> {
    const threshold = deps.cfg.autoCompactAt ?? 0;
    const window = deps.contextWindow();
    const used = window > 0 ? deps.getLastInputTokens() / window : 0;
    if (threshold > 0 && used >= threshold) {
        deps.emit({
            kind: "status-notice",
            text: `All tasks complete — context is at ${Math.round(used * 100)}% of the window, compacting now before continuing.`,
        });
        await deps.compactOnTasksComplete();
        return false;
    }
    deps.emit({
        kind: "status-notice",
        text: "All tasks complete — compacting context in the background once this turn ends.",
    });
    return true;
}

function isCompletedTaskTool(name: string, result: string): boolean {
    if (name !== "task_complete" && name !== "TaskUpdate") return false;
    try {
        return JSON.parse(result)?.allTasksComplete === true;
    } catch {
        return false;
    }
}

function parseArguments(value: string): Record<string, unknown> {
    try {
        return JSON.parse(value || "{}");
    } catch {
        return {};
    }
}
