/** Backend identifiers are open because custom OpenAI-compatible adapters use their own ids. */
export type AgentBackend = string;

/** Last terminal outcome that requires attention after a session stops. */
export type SessionTerminalStatus = "warning" | "error";

/** Live state shown by the sessions list. */
export type SessionStatus = "working" | "idle" | SessionTerminalStatus;

/** A session known to a backend, listed in the sessions tree. */
export interface SessionInfo {
    backend: AgentBackend;
    /** Friendly adapter name shown in the sessions list, e.g. "Sufficit AI". */
    backendName?: string;
    sessionId: string;
    title: string;
    cwd?: string;
    /** Git branch the session was working on (when the backend records it). Used to group sessions by task/feature. */
    gitBranch?: string;
    /** Original/root conversation id (claude-mem originSessionId). Sessions sharing it are the SAME logical conversation (continuations / re-runs). */
    lineageId?: string;
    updatedAt?: Date;
    /** Path to the stored transcript, when the backend keeps one. */
    transcriptPath?: string;
    /** Last model used in this session, when the backend records one (resume hint). */
    model?: string;
    /** Last reasoning/effort level used in this session, when available. */
    reasoning?: string;
    /** Set by the session store; true when the user archived it. */
    archived?: boolean;
    /** Set by the session store; true when pinned to the top. */
    pinned?: boolean;
    /** Order within the pinned group (0 = first). */
    pinIndex?: number;
    /** Live runtime status: a session with a running controller. */
    status?: SessionStatus;
    /** Last warning/error outcome, retained when the extension reloads. */
    terminalStatus?: SessionTerminalStatus;
    /** True while a permanent delete / scrub is in progress in the background. */
    deleting?: boolean;
    parentId?: string;
    continuationBlockedReason?: "codex-subagent" | "external-readonly";
    /** ID do preset de compressão configurado para esta seção (vazio usa padrão global). */
    compressionPresetId?: string;
}
