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
}
