import { EventEmitter } from "events";

/** Backend identifiers for the supported agent CLIs. */
// Built-in backends are "claude" | "codex" | "copilot" | "openai"; custom
// OpenAI-compatible adapters use their own id, so this is widened to string.
export type AgentBackend = string;

/** One entry of an agent's plan/todo list. */
export interface TodoItem {
    content: string;
    status: "pending" | "in_progress" | "completed";
    /** Optional explicit execution order (1-based); absent = array order. */
    order?: number;
}

/** A normalized event emitted by any adapter while a turn is running. */
export type AgentEvent =
    | { kind: "session"; sessionId: string; model?: string }
    | { kind: "text"; text: string; model?: string; modelLabel?: string }
    | { kind: "thinking"; text: string }
    | { kind: "tool-start"; toolName: string; detail?: string; toolId?: string; input?: string; added?: number; removed?: number; todos?: TodoItem[]; path?: string; diff?: { old: string; new: string }[]; terminalName?: string }
    | { kind: "tool-output"; toolName?: string; toolId?: string; text: string }
    | { kind: "tool-end"; toolName: string; detail?: string; toolId?: string; result?: string }
    | { kind: "turn-end"; costUsd?: number; durationMs?: number }
    | { kind: "usage"; inputTokens?: number; outputTokens?: number; cacheRead?: number; contextWindow?: number }
    | { kind: "error"; message: string; retryable?: boolean; fatal?: boolean };

/** A session known to a backend, listed in the sessions tree. */
export interface SessionInfo {
    backend: AgentBackend;
    sessionId: string;
    title: string;
    cwd?: string;
    updatedAt?: Date;
    /** Path to the stored transcript, when the backend keeps one. */
    transcriptPath?: string;
    /** Last model used in this session, when the backend records one (resume hint). */
    model?: string;
    /** Set by the session store; true when the user archived it. */
    archived?: boolean;
    /** Set by the session store; true when pinned to the top. */
    pinned?: boolean;
    /** Order within the pinned group (0 = first). */
    pinIndex?: number;
    /** Live runtime status: a session with a running controller. */
    status?: "working" | "idle";
    /** True while a permanent delete / scrub is in progress in the background. */
    deleting?: boolean;
}

/** One past message reconstructed from a stored transcript. */
export interface HistoryMessage {
    role: "user" | "assistant" | "tool" | "error" | "thinking";
    text: string;
    /** Model id and friendly label that produced this assistant message
     *  (preserved across backend/model handoff so each bubble keeps its origin). */
    model?: string;
    modelLabel?: string;
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
    diff?: { old: string; new: string }[];
    /** Original transcript time (ms) for hover timestamps. */
    ts?: number;
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
    /**
     * Prior conversation transcript to seed a brand-new session with, used when
     * handing a dialogue off from one backend to another so the new agent can
     * continue "as if nothing happened". Injected once, prepended to the first
     * user message. Unlike `resumeSessionId` (same backend, native resume), this
     * is plain context text that any backend can consume.
     */
    seedHistory?: string;
    /**
     * Extra environment for the spawned CLI process (e.g. tool secrets resolved
     * from the vault at spawn time). Merged after the adapter's static config env.
     */
    env?: Record<string, string>;
    /**
     * Allowlist of AI function-tool names (memory/web) exposed to API backends,
     * derived from the bound agent-def's declared tools. Undefined = expose all
     * (no agent gating); empty array = expose none.
     */
    aiTools?: string[];
    /**
     * System prompt to seed a fresh session with. Applied by API backends;
     * ignored on resume. Use for true system-level policy/instructions.
     */
    systemPrompt?: string;
    /**
     * Developer prompt to seed a fresh session with (agent-def body / working
     * instructions). Backends without native developer-role support should map
     * this to `system`.
     */
    developerPrompt?: string;
    /** Current presence: "away" = autonomous (API backends run tools unbounded). */
    autonomy?: string;
    /** How local shell/function executions should be shown to the user. */
    execDisplay?: "silent" | "inline" | "terminal";
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
    /**
     * Send one user message (optionally with image file paths to inline as
     * vision). `preamble` carries one-shot app instructions to insert as
     * `developer` messages before the user turn (role-aware backends only; CLIs
     * ignore it — they get the instructions prepended to `text` instead).
     */
    send(text: string, images?: string[], preamble?: string[]): void;
    /** Interrupt the current turn if the backend supports it. */
    cancel(): void;
    dispose(): void;
    /**
     * Per-session tool gating (native AI backend only). `aiTools()` reports the
     * full available tool set and the currently-enabled subset; `setAiTools`
     * replaces the enabled set live (applies to the next turn). Backends without
     * a runtime tool concept (CLIs) omit both.
     */
    aiTools?(): { available: string[]; enabled: string[] };
    setAiTools?(names: string[]): void;
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
    /**
     * True when the backend can take one-shot app instructions as `developer`
     * messages (via send's `preamble`) instead of glued onto the user text.
     * API backends return true; CLIs omit it (instructions are prepended).
     */
    roleAware?(): boolean;
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
    /**
     * Refresh the model list from a remote source (e.g. GET /models), then
     * resolve with the up-to-date list. Synchronous `models()` may return a
     * stale/fallback list before discovery completes; the chat surface awaits
     * this after posting `meta` to repopulate the picker. Optional: backends
     * with a static model list omit it.
     */
    refreshModels?(): Promise<{ models: string[]; labels?: Record<string, string> }>;
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
    /** True if the backend accepts images inlined in the message (vision). */
    supportsImages?(): boolean;
    /**
     * Permanently scrubs a session's stored data from disk (transcript plus
     * any shared history/index files). Returns the names of stores that may
     * still hold residual data and could not be surgically cleaned, if any.
     */
    deleteSession?(info: SessionInfo): Promise<string[] | void>;
}
