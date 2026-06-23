import { AgentAdapter, HistoryMessage, SessionInfo, SessionStartOptions } from "../adapters/types";

/**
 * Backend handoff for a chat surface: hands an ongoing dialogue off to another
 * backend WITHOUT leaving the screen — opens a fresh session on the target agent
 * seeded with the prior conversation, then replays the visible exchange so it
 * reads as one continuous dialogue. Works from a live chat controller, a live
 * terminal session, or a stored session. Extracted from ChatSurface.
 */
type Row = { role: "user" | "assistant"; text: string };

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
    for (const m of history) {
        if ((m.role === "user" || m.role === "assistant") && m.text?.trim()) {
            rows.push({ role: m.role, text: m.text.trim() });
        }
    }
    return rows;
}

function seedFrom(fromName: string, transcript: string): string | undefined {
    return transcript
        ? `[Conversation handed off from ${fromName}] You are taking over an ongoing dialogue. ` +
          `Below is the conversation so far between the user and the previous agent. ` +
          `Continue seamlessly, as if you had been part of it from the start — do not restart or re-introduce yourself.\n\n` +
          `=== Prior conversation ===\n${transcript}\n=== End of prior conversation ===`
        : undefined;
}

function rowsToTranscript(rows: Row[]): string {
    return rows.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.text}`).join("\n\n");
}

export class BackendHandoff {
    constructor(private readonly d: HandoffDeps) { }

    private displayName(backend: string): string {
        return (this.d.getAdapter(backend) as any)?.displayName ?? backend;
    }

    /** Replays carried-over history + a "continued with" note after a handoff. */
    private carry(messages: Row[], transcript: string, fromName: string, targetBackend: string, prefix = ""): void {
        if (!transcript) { return; }
        this.d.post({ type: "history", messages, carried: true });
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
        this.carry(from.transcriptMessages(), transcript, fromName, backend);
    }

    /** Hand a live TERMINAL session off (history read from the CLI transcript). */
    async fromTerminal(backend: string): Promise<void> {
        const from = this.d.getTerminalSession();
        if (!from || from.backend === backend) { return; }
        if (!this.d.getAdapter(backend)) { return; }
        const fromName = this.displayName(from.backend);
        const messages = historyToRows(await from.historyMessages());
        const transcript = rowsToTranscript(messages);
        this.openDialogueSeeded(backend, from.cwd, transcript, fromName, fromName);
        this.carry(messages, transcript, fromName, backend);
    }

    /** Hand a STORED session (from the sessions list) off to another backend. */
    async forSession(sessionId: string, sourceBackend: string, targetBackend: string): Promise<void> {
        if (sourceBackend === targetBackend) { return; }
        const source = this.d.getAdapter(sourceBackend);
        if (!source || !this.d.getAdapter(targetBackend)) { return; }
        const info = (await this.d.listSessions()).find((s) => s.sessionId === sessionId && s.backend === sourceBackend);
        if (!info) { return; }
        const fromName = this.displayName(sourceBackend);
        const history = source.history ? await source.history(info).catch(() => [] as HistoryMessage[]) : [];
        const messages = historyToRows(history);
        const transcript = rowsToTranscript(messages);
        this.openDialogueSeeded(targetBackend, this.d.cwdFor(info), transcript, info.title, fromName);
        this.carry(messages, transcript, fromName, targetBackend, fromName);
    }

    private openDialogueSeeded(backend: string, cwd: string, transcript: string, title: string, fromName: string): void {
        this.d.openDialogue(backend, { cwd, seedHistory: seedFrom(fromName, transcript) }, title);
    }
}
