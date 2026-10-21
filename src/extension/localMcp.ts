import type * as vscode from "vscode";
import { setLiveTranscriptReader } from "../adapters/aiTools";
import { setLocalMcpEndpoint } from "../adapters/localMcp/endpoint";
import { LocalMcpServer } from "../adapters/localMcp/server";
import { symposiumLocalTools } from "../adapters/localMcp/tools";
import type { LiveSessions } from "../sessions/runtime";
import { registerShutdownTask } from "./shutdown";

/**
 * Makes session history readable by every backend: live transcripts for the
 * in-process tool layer, plus an in-memory loopback MCP server so the Claude,
 * Codex and Copilot CLIs get the same `read_session` tool. Nothing is written
 * to disk; the endpoint disappears with the extension host.
 */
export async function registerSessionReading(
    context: vscode.ExtensionContext,
    runtime: LiveSessions,
    log: (message: string) => void,
): Promise<void> {
    // Read live transcripts before disk flush without importing the runtime in tools.
    setLiveTranscriptReader({ read: (id) => runtime.readTranscript(id) });
    context.subscriptions.push({ dispose: () => setLiveTranscriptReader(undefined) });

    const server = new LocalMcpServer(
        symposiumLocalTools(),
        log,
        String(context.extension.packageJSON.version),
    );
    try {
        setLocalMcpEndpoint(await server.start());
    } catch (error) {
        log(`[local-mcp] disabled: ${error instanceof Error ? error.message : String(error)}`);
    }
    context.subscriptions.push({ dispose: () => setLocalMcpEndpoint(undefined) });
    registerShutdownTask(() => server.dispose());
}
