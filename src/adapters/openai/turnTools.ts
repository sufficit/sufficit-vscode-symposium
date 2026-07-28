import { HubClient } from "../../sync/hubClient";
import {
    AI_TOOLS, AI_TOOLS_RESPONSES, LOCAL_TOOLS, LOCAL_TOOLS_RESPONSES,
    SUBAGENT_TOOLS, SUBAGENT_TOOLS_RESPONSES, getSubagentHost,
    runAiTool, ShellExecutionMode,
} from "../aiTools";
import { isLmTool, invokeLmTool, lmToolDefs, lmToolDefsResponses } from "../lmTools";
import { SessionStartOptions } from "../types";
import { mergeToolDefinitions } from "./toolMerge";

export function buildTurnTools(hubConfigured: boolean, responses: boolean) {
    const memoryTools = hubConfigured ? (responses ? AI_TOOLS_RESPONSES : AI_TOOLS) : [];
    const localTools = responses ? LOCAL_TOOLS_RESPONSES : LOCAL_TOOLS;
    const subagentTools = getSubagentHost() ? (responses ? SUBAGENT_TOOLS_RESPONSES : SUBAGENT_TOOLS) : [];
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
    if (isLmTool(args.name)) { return invokeLmTool(args.name, args.input); }
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
