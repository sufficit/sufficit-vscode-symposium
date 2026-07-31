import { HubClient } from "../../sync/hubClient";
import {
    AI_TOOLS, AI_TOOLS_RESPONSES, LOCAL_TOOLS, LOCAL_TOOLS_RESPONSES,
    SUBAGENT_TOOLS, SUBAGENT_TOOLS_RESPONSES, getSubagentHost,
    runAiTool, ShellExecutionMode,
} from "../aiTools";
import { isLmTool, invokeLmTool, lmToolDefs, lmToolDefsResponses } from "../lmTools";
import { SessionStartOptions } from "../types";
import { classifyLmTool } from "../aiTools/permissionTiers";
import { mergeToolDefinitions } from "./toolMerge";

export function buildTurnTools(hubConfigured: boolean, responses: boolean) {
    const memoryTools = hubConfigured ? (responses ? AI_TOOLS_RESPONSES : AI_TOOLS) : [];
    const localTools = responses ? LOCAL_TOOLS_RESPONSES : LOCAL_TOOLS;
    const subagentTools = getSubagentHost() ? (responses ? SUBAGENT_TOOLS_RESPONSES : SUBAGENT_TOOLS) : [];
    // Only bridged `vscode.lm.tools` carry a local registry-name alias. Native
    // tools (`shell`, filesystem, memory, subagents) retain their public names;
    // provider-specific cloaks belong to sufficit-ai, not to this merge layer.
    const vscodeTools = responses ? lmToolDefsResponses() : lmToolDefs();
    return mergeToolDefinitions([
        ...memoryTools.map((tool) => ({ tool, source: "sym_" })),
        ...localTools.map((tool) => ({ tool, source: "local_" })),
        ...subagentTools.map((tool) => ({ tool, source: "agent_" })),
        ...vscodeTools.map((tool) => ({ tool, source: "vscode_" })),
    ]);
}

export async function executeTurnTool(args: {
    name: string;
    input: Record<string, unknown>;
    toolId: string;
    hub: HubClient;
    options: SessionStartOptions;
    sessionId: string;
    backend: string;
    shellMode: ShellExecutionMode;
    abortSignal?: AbortSignal;
    emit: (event: Record<string, unknown>) => void;
}): Promise<string> {
    if (isLmTool(args.name)) {
        // LM tools (runInTerminal/runTask/runTests) bypass the ToolContext/containment
        // entirely (defect 6.2). When write-root containment is active AND not in admin
        // mode, block terminal/exec-classified LM tools so the agent can't escape roots
        // via VS Code tasks. Admin mode = user opted into no gates.
        const isAdmin = args.options.permission === "admin";
        const containmentActive = !isAdmin && Array.isArray(args.options.allowedWriteRoots) && args.options.allowedWriteRoots.length > 0;
        if (containmentActive) {
            const tier = classifyLmTool(args.name);
            if (tier === "destructive") {
                return JSON.stringify({ error: `Write-root guardrail: LM tool "${args.name}" is terminal/exec-capable and bypasses workspace containment. Blocked while write-root containment is active. Use the native shell tool (which is contained) instead.` });
            }
        }
        return invokeLmTool(args.name, args.input);
    }
    const progress = {
        onData: (chunk: string) => args.emit({ kind: "tool-output", toolName: args.name, toolId: args.toolId, text: chunk }),
        onTerminal: (terminalName: string) => args.emit({ kind: "tool-start", toolName: args.name, detail: `watching in terminal: ${terminalName}`, toolId: args.toolId, terminalName }),
        onNotify: (message: string) => args.emit({ kind: "tool-output", toolName: args.name, toolId: args.toolId, text: `\n[notify] ${message}\n` }),
    };
    return runAiTool(args.name, args.input, {
        hub: args.hub,
        cwd: args.options.cwd,
        allowedWriteRoots: args.options.allowedWriteRoots,
        permission: args.options.permission,
        sessionId: args.sessionId,
        shellExecution: args.shellMode,
        progress,
        parentBackend: args.backend,
        subagents: getSubagentHost(),
        abortSignal: args.abortSignal,
    });
}
