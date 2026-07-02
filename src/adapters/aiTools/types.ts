import { HubClient } from "../../sync/hubClient";

export type ShellExecutionMode = "silent" | "inline" | "terminal";

export interface ToolProgressSink {
    onData?(chunk: string): void;
    onTerminal?(terminalName: string): void;
    /** Model flagged this command's result as relevant — surface it to the user. */
    onNotify?(message: string): void;
}

export interface ToolContext {
    hub: HubClient;
    /** Session working directory — base for shell/fs tools and relative paths. */
    cwd: string;
    /** Permission mode; "plan" forbids mutating/executing tools (read-only). */
    permission?: string;
    /** Symposium chat session id — tasks saved to memory are bound to it. */
    sessionId?: string;
    /** How shell commands should be surfaced to the user. */
    shellExecution?: ShellExecutionMode;
    /** Live progress callbacks (stream output, terminal opened). */
    progress?: ToolProgressSink;
    /** Backend of the session running this tool — the default for spawned subagents. */
    parentBackend?: string;
    /** Spawns/controls subagents (set when the live runtime is available). */
    subagents?: SubagentHost;
    /** Signal to cancel running tool execution (shell commands, etc.). */
    abortSignal?: AbortSignal;
}

/** Live state of one spawned subagent. */
export interface SubagentStatus {
    /** Session id / registry key addressing the subagent. */
    id: string;
    /** Agent-def name driving it. */
    agent: string;
    /** Backend it runs on. */
    backend: string;
    /** working = a turn is running; idle = finished a turn; gone = stopped/disposed. */
    status: "working" | "idle" | "gone";
    /** Accumulated assistant text output (buffer-capped). */
    output: string;
    /** Number of tool steps it has taken. */
    steps: number;
    /** First error reported, if any. */
    error?: string;
}

/** A spawned subagent in the listing (id + identity, no output payload). */
export interface SubagentHandle {
    id: string;
    agent: string;
    backend: string;
    status: "working" | "idle" | "gone";
    title: string;
}

/**
 * Spawns and controls subagents as real sessions. Implemented over the live
 * runtime (see src/sessions/subagents.ts) and injected into ToolContext via the
 * late-bound module singleton below, so the low-level tool layer never imports
 * the runtime directly.
 */
export interface SubagentHost {
    spawn(opts: {
        agent: string;
        task: string;
        backend?: string;
        model?: string;
        cwd: string;
        background: boolean;
        parentSessionId?: string;
        parentBackend?: string;
    }): Promise<SubagentStatus>;
    status(id: string): SubagentStatus | undefined;
    send(id: string, text: string): boolean;
    stop(id: string): boolean;
    list(parentSessionId?: string): SubagentHandle[];
}

let subagentHost: SubagentHost | undefined;
/** Sets the process-wide subagent host (called once the live runtime exists). */
export function setSubagentHost(host: SubagentHost | undefined): void {
    subagentHost = host;
}
/** The current subagent host, or undefined when the runtime is unavailable. */
export function getSubagentHost(): SubagentHost | undefined {
    return subagentHost;
}

/**
 * Reads the live transcript of a running session straight from its controller —
 * the freshest copy, available before any ledger/store flush. Late-bound (same
 * pattern as SubagentHost) so the tool layer never imports the runtime.
 */
export interface LiveTranscriptReader {
    /** Live transcript for a running session, or undefined when none is live. */
    read(sessionId: string): { backend?: string; title?: string; messages: { role: string; text: string }[] } | undefined;
}

let liveTranscriptReader: LiveTranscriptReader | undefined;
/** Sets the process-wide live transcript reader (called once the runtime exists). */
export function setLiveTranscriptReader(reader: LiveTranscriptReader | undefined): void {
    liveTranscriptReader = reader;
}
/** The current live transcript reader, or undefined when the runtime is unavailable. */
export function getLiveTranscriptReader(): LiveTranscriptReader | undefined {
    return liveTranscriptReader;
}
