import { AgentAdapter, SessionInfo, SessionStartOptions } from "../adapters/types";
import { transcriptText } from "../application/controllerTranscript";
import { readRenderPage } from "../renderLog";

/**
 * Backend handoff for a chat surface: hands an ongoing dialogue off to another
 * backend WITHOUT leaving the screen — opens a fresh session on the target agent
 * seeded with the prior conversation, then replays the visible exchange so it
 * reads as one continuous dialogue. Works from a live chat controller, a live
 * terminal session, or a stored session. Extracted from ChatSurface.
 */
interface HandoffController {
    backend: string;
    title: string;
    cwd: string;
    sessionId: string | undefined;
    transcript(): string;
}
interface HandoffTerminal {
    backend: string;
    cwd: string;
    currentSessionId: string | undefined;
}

/** The Genius CLI can read its own sessions, so carry foreign history once at handoff. */
function geniusHandoffSeed(source: string, backend: string, title: string): string {
    const maxCharacters = 12_000;
    const rows = source
        .trim()
        .split(/\n\n(?=(?:user|assistant): )/)
        .filter(Boolean);
    const selected: string[] = [];
    let length = 0;
    for (let index = rows.length - 1; index >= 0; index -= 1) {
        const row = rows[index];
        if (length + row.length + 2 > maxCharacters) {
            if (!selected.length) selected.unshift(row.slice(-maxCharacters));
            selected.unshift("[Earlier source messages omitted]");
            break;
        }
        selected.unshift(row);
        length += row.length + 2;
    }
    const context = selected.length
        ? selected.join("\n\n")
        : "Source history was unavailable. Follow the user's latest request and ask for missing details only if needed.";
    return `[Backend handoff] Continued from ${backend}, conversation ${JSON.stringify(title)}. The source session belongs to another backend; Genius session_read cannot read it. Use the source exchange below as context.\n\n${context}`;
}

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
        return adapter ? adapter.displayName || backend : backend;
    }

    private openDialogueSeeded(
        backend: string,
        cwd: string,
        title: string,
        fromName: string,
        parentId?: string,
        sourceTranscript?: string,
    ): void {
        const adapter = this.d.getAdapter(backend);
        if (!adapter || adapter.canStartSessions === false) {
            return;
        }
        const genius = backend === "genius";
        const source = genius
            ? sourceTranscript ||
              (parentId ? transcriptText(readRenderPage(parentId).messages) : "")
            : "";
        const options: SessionStartOptions = {
            cwd,
            model: undefined,
            permission: undefined,
            env: {},
            parentId,
            ...(genius
                ? { seedHistory: geniusHandoffSeed(source, fromName, title) }
                : { handoff: { sessionId: parentId, backend: fromName, title } }),
        };
        this.d.openDialogue(backend, options, title);
        this.d.post({
            type: "set-input",
            text: genius
                ? "Continue the conversation using the transferred context."
                : `Continue the parent conversation${parentId ? ` (${parentId})` : ""}.`,
        });
    }

    /**
     * Hands off a live ChatController session to a new backend.
     * Carries recent source history to Genius when the native session store differs.
     */
    switch(backend: string): void {
        const from = this.d.getController();
        if (!from || from.backend === backend) {
            return;
        }
        const target = this.d.getAdapter(backend);
        if (!target || target.canStartSessions === false) {
            return;
        }
        const fromName = this.displayName(from.backend);
        const sourceSessionId = from.sessionId;
        this.openDialogueSeeded(
            backend,
            from.cwd,
            from.title,
            fromName,
            sourceSessionId,
            backend === "genius" ? from.transcript() : undefined,
        );
    }

    /** Hand a live TERMINAL session off (history read from the CLI transcript). */
    switchTerminal(backend: string): void {
        const term = this.d.getTerminalSession();
        if (!term) {
            return;
        }
        const target = this.d.getAdapter(backend);
        if (!target || target.canStartSessions === false) {
            return;
        }
        const fromName = this.displayName(term.backend);
        this.openDialogueSeeded(
            backend,
            term.cwd,
            `From ${term.backend} (terminal)`,
            fromName,
            term.currentSessionId,
        );
    }

    /**
     * Hands off a stored session to a new backend.
     * Reads the transcript from storage and replays it.
     */
    async switchSession(sessionId: string): Promise<void> {
        const sessions = await this.d.listSessions();
        const info = sessions.find((s) => s.sessionId === sessionId);
        if (!info) {
            return;
        }
        const fromName = this.displayName(info.backend);
        const cwd = this.d.cwdFor(info);
        const parentId = sessionId; // new session links to the stored one
        this.openDialogueSeeded("claude", cwd, info.title, fromName, parentId);
    }

    async switchToSession(sessionId: string): Promise<void> {
        const sessions = await this.d.listSessions();
        const info = sessions.find((s) => s.sessionId === sessionId);
        if (!info) {
            return;
        }
        const fromName = this.displayName(info.backend);
        const parentId = sessionId; // new session links to the stored one
        this.openDialogueSeeded(info.backend, this.d.cwdFor(info), info.title, fromName, parentId);
    }

    /**
     * Hands off a stored session from one backend to another backend.
     * The session is looked up by id, and the transcript is read from storage.
     */
    async switchFromSession(
        sessionId: string,
        sourceBackend: string,
        targetBackend: string,
    ): Promise<void> {
        const sessions = await this.d.listSessions();
        const info = sessions.find((s) => s.sessionId === sessionId && s.backend === sourceBackend);
        if (!info) {
            return;
        }
        const fromName = this.displayName(info.backend);
        const targetAdapter = this.d.getAdapter(targetBackend);
        if (!targetAdapter || targetAdapter.canStartSessions === false) {
            return;
        }
        const parentId = sessionId; // new session links to the stored one
        this.openDialogueSeeded(targetBackend, this.d.cwdFor(info), info.title, fromName, parentId);
    }

    /** Alias for switchTerminal (used by surfaceMessages). */
    fromTerminal(backend: string): void {
        this.switchTerminal(backend);
    }

    /** Alias for switchFromSession (used by surfaceMessages). */
    forSession(sessionId: string, backend: string, targetBackend: string): Promise<void> {
        return this.switchFromSession(sessionId, backend, targetBackend);
    }
}
