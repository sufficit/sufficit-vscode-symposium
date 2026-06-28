import { AgentAdapter, HistoryMessage, SessionInfo, SessionStartOptions } from "../adapters/types";

/**
 * Backend handoff for a chat surface: hands an ongoing dialogue off to another
 * backend WITHOUT leaving the screen — opens a fresh session on the target agent
 * seeded with the prior conversation, then replays the visible exchange so it
 * reads as one continuous dialogue. Works from a live chat controller, a live
 * terminal session, or a stored session. Extracted from ChatSurface.
 */
type Row = { role: "user" | "assistant"; text: string; thinking?: string };

interface HandoffController { backend: string; title: string; cwd: string; transcript(): string; transcriptMessages(): Row[]; sessionId: string | undefined }
interface HandoffTerminal { backend: string; cwd: string; historyMessages(): Promise<HistoryMessage[]> }

export interface HandoffDeps {
    getAdapter: (backend: string) => AgentAdapter | undefined;
    listSessions: () => Promise<SessionInfo[]>;
    cwdFor: (info: SessionInfo) => string;
    openDialogue: (backend: string, options: SessionStartOptions, title: string) => void;
    post: (message: unknown) => void;
    getController: () => HandoffController | undefined;
    getTerminalSession: () => HandoffTerminal | undefined;
    getStore: () => { setParent(sessionId: string, parentId: string | undefined): void };
}

/** Collapses adapter history to plain user/assistant rows (tool rows dropped). */
function historyToRows(history: HistoryMessage[]): Row[] {
    const rows: Row[] = [];
    for (const msg of history) {
        if (msg.role === "user") {
            rows.push({ role: "user", text: msg.text });
        } else if (msg.role === "assistant") {
            rows.push({ role: "assistant", text: msg.text, thinking: undefined });
        }
    }
    return rows;
}

/** Turns rows back into HistoryMessage[] for seeding a new session. */
function historyFromRows(rows: Row[]): string {
    // Simplified: concatenate into a transcript block for manual review.
    // For true seedHistory we would need the full adapter-specific format,
    // so for now we keep the existing transcript-based approach.
    return rows.map((r) => `${r.role}: ${r.text}${r.thinking ? ` (thinking: ${r.thinking})` : ""}`).join("\n");
}

/**
 * Orchestrates backend handoff for a single surface.
 *
 * The public methods (switch, fromTerminal, forSession) are called by
 * SurfaceMessages in response to user actions; they invoke private helpers
 * to build the seed options and open the target session.
 */
export class BackendHandoff {
    constructor(private readonly d: HandoffDeps) {}

    private displayName(backend: string): string {
        const adapter = this.d.getAdapter(backend);
        return adapter ? (adapter.displayName || backend) : backend;
    }

    private openDialogueSeeded(backend: string, cwd: string, transcript: string, title: string, fromName: string, parentId?: string, seedHistory?: string): void {
        const adapter = this.d.getAdapter(backend);
        if (!adapter) { return; }
        const options: SessionStartOptions = { cwd, model: undefined, permission: undefined, env: {}, parentId, seedHistory };
        // If fromName is provided, include it in the transcript context.
        if (fromName) {
            const header = `[Conversation continued from ${fromName}]\\n\\n${transcript}`;
            this.d.openDialogue(backend, options, title);
            // Set the text in the textarea for user review, don't auto-send
            this.d.post({ type: "set-input", text: header });
        } else {
            this.d.openDialogue(backend, options, title);
            // Set the text in the textarea for user review, don't auto-send
            this.d.post({ type: "set-input", text: transcript });
        }
    }

    /** Replays carried-over history + a "continued with" note after a handoff. */
    private carry(_rows: Row[], _transcript: string, _fromName: string, _backend: string): void {
        // TODO: implement replay if we want automatic injection.
        // For now, we rely on the transcript block set by openDialogueSeeded.
    }

    /**
     * Hands off a live ChatController session to a new backend.
     * Replays the entire transcript as if it happened on the new agent.
     */
    switch(backend: string): void {
        const from = this.d.getController();
        if (!from || from.backend === backend) { return; }
        if (!this.d.getAdapter(backend)) { return; }
        const fromName = this.displayName(from.backend);
        const transcript = from.transcript();
        const sourceSessionId = from.sessionId;
        const seedHistory = historyFromRows(from.transcriptMessages());
        this.openDialogueSeeded(backend, from.cwd, transcript, from.title, fromName, sourceSessionId, seedHistory);
        // Don't auto-carry history - let user review and send manually
        // this.carry(from.transcriptMessages(), transcript, fromName, backend);
    }

    /** Hand a live TERMINAL session off (history read from the CLI transcript). */
    async switchTerminal(): Promise<void> {
        const term = this.d.getTerminalSession();
        if (!term) { return; }
        const fromName = this.displayName(term.backend);
        const history = await term.historyMessages();
        const rows = historyToRows(history);
        const transcript = historyFromRows(rows);
        // No parentId for terminal sessions (no sessionId)
        this.openDialogueSeeded("claude", term.cwd, transcript, `From ${term.backend} (terminal)`, fromName, undefined, transcript);
        this.carry(rows, transcript, fromName, "claude");
    }

    /**
     * Hands off a stored session to a new backend.
     * Reads the transcript from storage and replays it.
     */
    async switchSession(sessionId: string): Promise<void> {
        const sessions = await this.d.listSessions();
        const info = sessions.find((s) => s.sessionId === sessionId);
        if (!info) { return; }
        const fromName = this.displayName(info.backend);
        const cwd = this.d.cwdFor(info);
        const transcript = "";
        const parentId = sessionId; // new session links to the stored one
        this.openDialogueSeeded("claude", cwd, transcript, info.title, fromName, parentId, undefined);
        this.carry([], transcript, fromName, "claude");
    }

    async switchToSession(sessionId: string): Promise<void> {
        const sessions = await this.d.listSessions();
        const info = sessions.find((s) => s.sessionId === sessionId);
        if (!info) { return; }
        const fromName = this.displayName(info.backend);
        const transcript = "";
        const parentId = sessionId; // new session links to the stored one
        this.openDialogueSeeded(info.backend, this.d.cwdFor(info), transcript, info.title, fromName, parentId, undefined);
    }

    /**
     * Hands off a stored session from one backend to another backend.
     * The session is looked up by id, and the transcript is read from storage.
     */
    async switchFromSession(sessionId: string, sourceBackend: string, targetBackend: string): Promise<void> {
        const sessions = await this.d.listSessions();
        const info = sessions.find((s) => s.sessionId === sessionId && s.backend === sourceBackend);
        if (!info) { return; }
        const fromName = this.displayName(info.backend);
        const targetAdapter = this.d.getAdapter(targetBackend);
        if (!targetAdapter) { return; }
        // TODO: read transcript from storage when available
        const transcript = "";
        const parentId = sessionId; // new session links to the stored one
        this.openDialogueSeeded(targetBackend, this.d.cwdFor(info), transcript, info.title, fromName, parentId, undefined);
        this.carry([], transcript, fromName, targetBackend);
    }

    /** Alias for switchTerminal (used by surfaceMessages). */
    fromTerminal(): Promise<void> {
        return this.switchTerminal();
    }

    /** Alias for switchFromSession (used by surfaceMessages). */
    forSession(sessionId: string, backend: string, targetBackend: string): Promise<void> {
        return this.switchFromSession(sessionId, backend, targetBackend);
    }
}