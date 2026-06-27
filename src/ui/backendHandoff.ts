import { AgentAdapter, HistoryMessage, SessionInfo, SessionStartOptions } from "../adapters/types";

/**
 * Backend handoff for a chat surface: hands an ongoing dialogue off to another
 * backend WITHOUT leaving the screen — opens a fresh session on the target agent
 * seeded with the prior conversation, then replays the visible exchange so it
 * reads as one continuous dialogue. Works from a live chat controller, a live
 * terminal session, or a stored session. Extracted from ChatSurface.
 */
type Row = { role: "user" | "assistant"; text: string; thinking?: string };

interface HandoffController { backend: string; title: string; cwd: string; transcript(): string; transcriptMessages(): Row[]; }
interface HandoffTerminal { backend: string; cwd: string; historyMessages(): Promise<HistoryMessage[]>; }

export interface HandoffDeps {
    getAdapter: (backend: string) => AgentAdapter | undefined;
    listSessions: () => Promise<SessionInfo[]>;
    cwdFor: (info: SessionInfo) => string;
    openDialogue: (backend: string, options: SessionStartOptions, title: string) => void;
    post: (message: unknown) => void;
    getController: () => HandoffController | undefined;
    getTerminalSession: () => HandoffTerminal | undefined;
}

/** Collapses adapter history to plain user/assistant rows (tool rows dropped). */
function historyToRows(history: HistoryMessage[]): Row[] {
    const rows: Row[] = [];
    let currentAssistant: { text: string; thinking?: string } | undefined;
    for (const m of history) {
        if (m.role === "user" && typeof m.text === "string") {
            // Flush any pending assistant row
            if (currentAssistant) {
                rows.push({ role: "assistant", text: currentAssistant.text, thinking: currentAssistant.thinking });
                currentAssistant = undefined;
            }
            rows.push({ role: "user", text: m.text });
        } else if (m.role === "assistant" && typeof m.text === "string") {
            // Flush any pending assistant row and start a new one
            if (currentAssistant) {
                rows.push({ role: "assistant", text: currentAssistant.text, thinking: currentAssistant.thinking });
            }
            currentAssistant = { text: m.text, thinking: undefined };
        } else if (m.role === "thinking" && typeof m.text === "string") {
            // Attach thinking to the current assistant row
            if (!currentAssistant) {
                currentAssistant = { text: "", thinking: m.text };
            } else {
                currentAssistant.thinking = m.text;
            }
        }
    }
    // Flush any remaining assistant row
    if (currentAssistant) {
        rows.push({ role: "assistant", text: currentAssistant.text, thinking: currentAssistant.thinking });
    }
    return rows;
}

/** Convert transcript row back to HistoryMessage (for seeding new sessions). */
function rowsToHistory(rows: Row[]): HistoryMessage[] {
    const messages: HistoryMessage[] = [];
    let ts = Date.now();
    for (const r of rows) {
        if (r.role === "user") {
            messages.push({ role: "user", text: r.text, ts });
        } else if (r.role === "assistant") {
            if (r.thinking) {
                messages.push({ role: "thinking", text: r.thinking, ts });
            }
            if (r.text) {
                messages.push({ role: "assistant", text: r.text, ts });
            }
        }
        ts += 1000;
    }
    return messages;
}

/** Backend handoff logic extracted from ChatSurface. */
export class BackendHandoff {
    constructor(private readonly d: HandoffDeps) { }

    /** Normalized display name for a backend. */
    private displayName(backend: string): string {
        if (backend === "claude") return "Claude Code";
        if (backend === "codex") return "Codex";
        if (backend === "copilot") return "Copilot";
        if (backend === "openai") return "OpenAI";
        return backend;
    }

    private async openDialogueSeeded(backend: string, cwd: string, transcript: string, title: string, fromName: string): Promise<void> {
        const adapter = this.d.getAdapter(backend);
        if (!adapter) { return; }
        const options: SessionStartOptions = { cwd, model: undefined, permission: undefined, env: {} };
        // If fromName is provided, include it in the transcript context.
        if (fromName) {
            const header = `[Conversation continued from ${fromName}]\n\n${transcript}`;
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
    private carry(messages: Row[], transcript: string, fromName: string, targetBackend: string, prefix = ""): void {
        if (!transcript) { return; }
        this.d.post({ type: "history", messages: rowsToHistory(messages), carried: true });
        const targetName = this.displayName(targetBackend);
        const note = prefix
            ? `_↪ Conversation from **${fromName}** continued with **${targetName}** — the prior exchange above was carried over as context._`
            : `_↪ Conversation continued with **${targetName}** — the prior exchange above was carried over as context._`;
        this.d.post({ type: "event", event: { kind: "text", text: note } });
        this.d.post({ type: "event", event: { kind: "turn-end" } });
    }

    /** Hand the live chat controller off to another backend (in place). */
    switch(backend: string): void {
        const from = this.d.getController();
        if (!from || from.backend === backend) { return; }
        if (!this.d.getAdapter(backend)) { return; }
        const fromName = this.displayName(from.backend);
        const transcript = from.transcript();
        this.openDialogueSeeded(backend, from.cwd, transcript, from.title, fromName);
        // Don't auto-carry history - let user review and send manually
        // this.carry(from.transcriptMessages(), transcript, fromName, backend);
    }

    /** Hand a live TERMINAL session off (history read from the CLI transcript). */
    async switchTerminal(): Promise<void> {
        const term = this.d.getTerminalSession();
        if (!term) { return; }
        const fromName = this.displayName(term.backend);
        const history = await term.historyMessages();
        const messages = historyToRows(history);
        const transcript = messages.map((m) => `${m.role}: ${m.text}`).join("\n\n");
        this.openDialogueSeeded("claude", term.cwd, transcript, `From ${term.backend} (terminal)`, fromName);
        this.carry(messages, transcript, fromName, "claude");
    }

    /** Hand off from a stored session (user picks from session list). */
    async switchSession(sessionId: string): Promise<void> {
        const sessions = await this.d.listSessions();
        const info = sessions.find((s) => s.sessionId === sessionId);
        if (!info) { return; }
        const fromName = this.displayName(info.backend);
        const cwd = this.d.cwdFor(info);
        const adapter = this.d.getAdapter(info.backend);
        if (!adapter) { return; }
        // TODO: read transcript from storage when available
        const transcript = "";
        this.openDialogueSeeded("claude", cwd, transcript, info.title, fromName);
        this.carry([], transcript, fromName, "claude");
    }

    /** Hand off TO a stored session (open it and carry the current controller context). */
    async switchToSession(sessionId: string): Promise<void> {
        const sessions = await this.d.listSessions();
        const info = sessions.find((s) => s.sessionId === sessionId);
        if (!info) { return; }
        const from = this.d.getController();
        if (!from) { return; }
        const fromName = this.displayName(from.backend);
        const transcript = from.transcript();
        this.openDialogueSeeded(info.backend, this.d.cwdFor(info), transcript, info.title, fromName);
        this.carry(from.transcriptMessages(), transcript, fromName, info.backend, `[→ Opened "${info.title}"]`);
    }

    /** Hand off from a stored session to another backend (branching). */
    async switchFromSession(sessionId: string, sourceBackend: string, targetBackend: string): Promise<void> {
        const sessions = await this.d.listSessions();
        const info = sessions.find((s) => s.sessionId === sessionId && s.backend === sourceBackend);
        if (!info) { return; }
        const fromName = this.displayName(info.backend);
        const adapter = this.d.getAdapter(targetBackend);
        if (!adapter) { return; }
        // TODO: read transcript from storage when available
        const transcript = "";
        this.openDialogueSeeded(targetBackend, this.d.cwdFor(info), transcript, info.title, fromName);
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
