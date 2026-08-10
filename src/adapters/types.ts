import { EventEmitter } from "events";
import type { TodoItem } from "./events";
import type { AgentBackend, SessionInfo } from "./sessionInfo";
import type { AdapterUsageProvider } from "./quotaTypes";

export type { AgentBackend, SessionInfo, SessionTerminalStatus } from "./sessionInfo";
export type { AdapterQuotaSnapshot, AdapterUsageProvider, UsageQuotaWindow } from "./quotaTypes";
export type { AgentEvent, SystemNoticeSeverity, TodoItem } from "./events";

/** One past message reconstructed from a stored transcript. */
export interface HistoryMessage {
    role: "user" | "assistant" | "tool" | "error" | "thinking";
    /**
     * Null means the adapter found a turn but produced no text for it (e.g. an
     * image/attachment-only user message with no caption). Each adapter decides
     * whether to emit null here or fill in its own placeholder text; the render
     * layer shows a generic "no text" placeholder for null either way.
     */
    text: string | null;
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

/**
 * One page of session history. Adapters that can paginate return an opaque
 * {@link nextCursor} the host passes back to load the next older page; absence
 * means the transcript is fully loaded. Adapters without pagination return all
 * messages at once and omit the cursor.
 */
export interface HistoryPage {
    messages: HistoryMessage[];
    /** Opaque cursor to pass back to {@link AgentAdapter.history} for older turns. */
    nextCursor?: string;
}

/** Stops a live transcript follow. */
export interface FollowHandle {
    dispose(): void;
    /**
     * Optional: subscribe to a working/idle signal inferred from the followed
     * transcript (no local process to query). Fires only on a state transition.
     * Adapters that can't infer a turn boundary omit it (no regression).
     */
    onStatus?(cb: (status: "working" | "idle") => void): void;
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
    /**
     * Authorized write roots for this session: when set (non-empty), host-level
     * containment blocks write_file/edit_file and shell cwd outside these paths
     * (delivery 1E write-root guardrail). Empty/undefined = no containment.
     * Typically computed from the open workspace folders.
     */
    allowedWriteRoots?: string[];
    /** Resume an existing session instead of starting a new one. */
    resumeSessionId?: string;
    /** Model override; adapters map it to their CLI flag. */
    model?: string;
    /** Reasoning/thinking effort level; adapters map it to their CLI flag. */
    reasoning?: string;
    /** Permission/approval mode (backend-specific); adapters map it to a flag. */
    permission?: string;
    /** ID do preset de compressão para esta seção (vazio usa padrão global). */
    compressionPresetId?: string;
    /**
     * Conversation lineage to inherit (branching). When set, the new session is
     * treated as a continuation of the same logical conversation as the session
     * that owns this id — the sidebar groups them under one expandable head and
     * delete/archive cascade across the lineage. Empty/undefined = a brand-new
     * conversation. (Mirrors `SessionInfo.lineageId`.)
     */
    lineageId?: string;
    /**
     * Prior conversation transcript to seed a brand-new session with, used when
     * handing a dialogue off from one backend to another so the new agent can
     * continue "as if nothing happened". Injected once, prepended to the first
     * user message. Unlike `resumeSessionId` (same backend, native resume), this
     * is plain context text that any backend can consume.
     */
    seedHistory?: string;
    /**
     * Read-only parent conversation reference for a cross-backend handoff.
     * The target receives this as a compact first-turn instruction and can use
     * read_session to fetch only the portions of the source it needs.
     */
    handoff?: { sessionId?: string; backend: string; title: string };
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
    /**
     * Name of the local agent-def bound to this session (from
     * `symposium.newAgentSession`). Surfaced as an inline meta badge so the
     * dialogue always shows which agent is driving it.
     */
    agentName?: string;
    /** Tools the bound agent-def declares (shown in the agent meta badge). */
    toolsDeclared?: string[];
    /** Subset of AI tools actually exposed after gating (memory/web). */
    toolsAllowed?: string[];
    /**
     * Per-workspace bootstrap context (curated Sufficit knowledge), injected once
     * before the user's first message on a new session. Plain text, prepended
     * like seedHistory so every backend consumes it. Resolved by the surface from
     * `repo/bootstrap/<workspaceKey>.md`.
     */
    bootstrap?: string;
    /**
     * Parent session id when this session is a spawned subagent. Carried into the
     * live runtime so the sessions list can nest it under its parent.
     */
    parentId?: string;
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
    send(
        text: string,
        images?: string[],
        preamble?: string[],
        intentId?: string,
        resumeTurnId?: string,
    ): void;
    /**
     * Replaces the model for the next turn. The currently running CLI/API
     * request is intentionally left unchanged.
     */
    setModel?(model: string): void;
    /** Effective model used by the latest backend turn, when available. */
    getModel?(): string;
    /** Interrupt the current turn if the backend supports it. */
    cancel(): void;
    /** Resume a backend-owned pause without adding a user message to the model context. */
    continueTurn?(): void;
    dispose(): void;
    /**
     * Per-session tool gating (native AI backend only). `aiTools()` reports the
     * full available tool set and the currently-enabled subset; `setAiTools`
     * replaces the enabled set live (applies to the next turn). Backends without
     * a runtime tool concept (CLIs) omit both.
     */
    aiTools?(): { available: string[]; enabled: string[] };
    setAiTools?(names: string[]): void;
    /** Persistir o estado da sessão (apenas para backends que suportam persistência local). */
    safePersist?(): void;
    /**
     * Answers a pending "approval-request" event (admin/manager/user modes).
     * Only implemented by adapters that gate their own tool execution
     * in-process (currently openai); a no-op elsewhere.
     */
    resolveApproval?(toolId: string, approved: boolean): void;
}

/** Factory + discovery surface for one backend CLI. */
export interface AgentAdapter {
    readonly backend: AgentBackend;
    readonly usage: AdapterUsageProvider;
    /**
     * Friendly name shown in pickers and the chat header. Optional: CLI
     * adapters fall back to `backend`; the HTTP adapters set a display name
     * (e.g. "Sufficit AI") that differs from their id.
     */
    readonly displayName?: string;
    /** Quick availability probe (CLI on PATH, version readable). */
    available(): Promise<{ ok: boolean; version?: string; error?: string }>;
    listSessions(): Promise<SessionInfo[]>; // stored sessions for the tree view
    listSessionsIncremental?(cached: readonly SessionInfo[]): Promise<SessionInfo[]>;
    /** Start a new live session (or resume one). */
    start(options: SessionStartOptions): AgentSession;
    /**
     * True when the backend can take one-shot app instructions as `developer`
     * messages (via send's `preamble`) instead of glued onto the user text.
     * API backends return true; CLIs omit it (instructions are prepended).
     */
    roleAware?(): boolean;
    /**
     * Reconstruct past messages of a stored session, newest last. When
     * {@link cursor} is omitted, loads the most recent page; when present (a
     * value previously returned as {@link HistoryPage.nextCursor}), loads the
     * next older page. Adapters that don't paginate ignore the cursor and
     * return everything at once.
     */
    history?(info: SessionInfo, cursor?: string): Promise<HistoryPage>;
    /**
     * Watch a stored transcript and stream messages appended after the
     * point `history()` already returned (read-only live mirror of a
     * session running elsewhere). `onMessage` fires per new entry.
     */
    follow?(info: SessionInfo, onMessage: (message: HistoryMessage) => void): FollowHandle;
    /** Models offered in the chat panel picker; first entry is the default. */
    models?(): string[];
    /**
     * Map of model id → friendly label, when the backend discovers human names
     * for its model ids (e.g. an OpenAI-compatible `/models` catalog). Used to
     * resolve agent-def model pins and to label the picker. CLIs omit it.
     */
    modelLabels?(): Record<string, string>;
    /**
     * Refresh the model list from a remote source (e.g. GET /models), then
     * resolve with the up-to-date list. Synchronous `models()` may return a
     * stale/fallback list before discovery completes; the chat surface awaits
     * this after posting `meta` to repopulate the picker. Optional: backends
     * with a static model list omit it.
     */
    refreshModels?(force?: boolean): Promise<{ models: string[]; labels?: Record<string, string> }>;
    /** Canonical Symposium effort levels supported by this adapter; first entry = no override. */
    reasoningLevels?(): string[];
    /** Maps canonical Symposium effort names to native CLI/API values. */
    reasoningMap?(): Record<string, string>;
    /** Effective canonical effort used by the backend when no explicit override is sent. */
    defaultReasoning?(): string;
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
