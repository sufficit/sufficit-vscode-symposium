import { EventEmitter } from "events";

/** Backend identifiers for the supported agent CLIs. */
export type AgentBackend = "claude" | "codex" | "copilot";

/** A normalized event emitted by any adapter while a turn is running. */
export type AgentEvent =
    | { kind: "session"; sessionId: string; model?: string }
    | { kind: "text"; text: string }
    | { kind: "tool-start"; toolName: string; detail?: string }
    | { kind: "tool-end"; toolName: string; detail?: string }
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
}

/** One past message reconstructed from a stored transcript. */
export interface HistoryMessage {
    role: "user" | "assistant" | "tool";
    text: string;
}

/** Stops a live transcript follow. */
export interface FollowHandle {
    dispose(): void;
}

/** Options for starting or resuming a live session. */
export interface SessionStartOptions {
    cwd: string;
    /** Resume an existing session instead of starting a new one. */
    resumeSessionId?: string;
    /** Model override; adapters map it to their CLI flag. */
    model?: string;
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
}
