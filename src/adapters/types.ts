import { EventEmitter } from "events";

/** Backend identifiers for the supported agent CLIs. */
// Built-in backends are "claude" | "codex" | "copilot" | "openai"; custom
// OpenAI-compatible adapters use their own id, so this is widened to string.
export type AgentBackend = string;

/** One entry of an agent's plan/todo list. */
export interface TodoItem {
    content: string;
    status: "pending" | "in_progress" | "completed";
}

/** A normalized event emitted by any adapter while a turn is running. */
export type AgentEvent =
    | { kind: "session"; sessionId: string; model?: string }
    | { kind: "text"; text: string }
    | { kind: "tool-start"; toolName: string; detail?: string; toolId?: string; input?: string; added?: number; removed?: number; todos?: TodoItem[]; path?: string }
    | { kind: "tool-end"; toolName: string; detail?: string; toolId?: string; result?: string }
    | { kind: "turn-end"; costUsd?: number; durationMs?: number }
    | { kind: "error"; message: string };

/** A session known to a backend, listed in the sessions tree. */
export interface SessionInfo {
    backend: AgentBackend;
    sessionId: string;
    title: string;
    cwd?: string;
    updatedAt?: Date;
    /** Path to the stored transcript, when the backend keeps one. */
    transcriptPath?: string;
    /** Set by the session store; true when the user archived it. */
    archived?: boolean;
    /** Live runtime status: a session with a running controller. */
    status?: "working" | "idle";
}

/** One past message reconstructed from a stored transcript. */
export interface HistoryMessage {
    role: "user" | "assistant" | "tool";
    text: string;
    // For tool rows: the backend tool name and a short human target, so stored
    // transcripts render the same icon+verb+target as live events. input/result
    // hold the full (pretty) payloads for the expandable panel.
    toolName?: string;
    detail?: string;
    input?: string;
    result?: string;
    added?: number;
    removed?: number;
    todos?: TodoItem[];
    path?: string;
}

/** Stops a live transcript follow. */
export interface FollowHandle {
    dispose(): void;
}

/** A slash command / skill offered by a backend for composer autocomplete. */
export interface SlashCommand {
    name: string;
    description?: string;
    kind?: "skill" | "command" | "builtin";
}

/** Options for starting or resuming a live session. */
export interface SessionStartOptions {
    cwd: string;
    /** Resume an existing session instead of starting a new one. */
    resumeSessionId?: string;
    /** Model override; adapters map it to their CLI flag. */
    model?: string;
    /** Reasoning/thinking effort level; adapters map it to their CLI flag. */
    reasoning?: string;
    /** Permission/approval mode (backend-specific); adapters map it to a flag. */
    permission?: string;
}

/**
 * One live agent process bound to one dialogue session.
 *
 * Emits "event" with AgentEvent payloads. The adapter owns the child
 * process; dispose() must terminate it.
 */
export interface AgentSession extends EventEmitter {
    readonly backend: AgentBackend;
    /** Undefined until the backend reports the session id. */
    readonly sessionId: string | undefined;
    /** Send one user message; events stream until turn-end. */
    send(text: string): void;
    /** Interrupt the current turn if the backend supports it. */
    cancel(): void;
    dispose(): void;
}

/** Factory + discovery surface for one backend CLI. */
export interface AgentAdapter {
    readonly backend: AgentBackend;
    /** Quick availability probe (CLI on PATH, version readable). */
    available(): Promise<{ ok: boolean; version?: string; error?: string }>;
    /** Enumerate stored sessions for the tree view. */
    listSessions(): Promise<SessionInfo[]>;
    /** Start a new live session (or resume one). */
    start(options: SessionStartOptions): AgentSession;
    /** Reconstruct past messages of a stored session, newest last. */
    history?(info: SessionInfo): Promise<HistoryMessage[]>;
    /**
     * Watch a stored transcript and stream messages appended after the
     * point `history()` already returned (read-only live mirror of a
     * session running elsewhere). `onMessage` fires per new entry.
     */
    follow?(info: SessionInfo, onMessage: (message: HistoryMessage) => void): FollowHandle;
    /** Models offered in the chat panel picker; first entry is the default. */
    models?(): string[];
    /** Reasoning/thinking effort levels for the picker; first entry = CLI default (no flag). */
    reasoningLevels?(): string[];
    /** Permission/approval modes for the config menu (backend-specific). */
    permissionModes?(): string[];
    /** The currently configured default permission mode. */
    defaultPermission?(): string;
    /** Slash commands / skills offered for composer autocomplete. */
    commands?(): Promise<SlashCommand[]>;
    /**
     * Whether the CLI has a native plan/todo tool (e.g. Claude TodoWrite,
     * Codex update_plan). When false, Symposium injects a todo capability and
     * parses a fenced ```todo block from the agent's replies instead.
     */
    hasNativeTodo?(): boolean;
    /** Instruction injected to give a plan capability when there's no native one. */
    todoInjection?(): string | undefined;
    /**
     * Permanently scrubs a session's stored data from disk (transcript plus
     * any shared history/index files). Returns the names of stores that may
     * still hold residual data and could not be surgically cleaned, if any.
     */
    deleteSession?(info: SessionInfo): Promise<string[] | void>;
}
