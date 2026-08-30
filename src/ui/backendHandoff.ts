import { AgentAdapter, SessionInfo, SessionStartOptions } from "../adapters/types";

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
}
interface HandoffTerminal {
    backend: string;
    cwd: string;
    currentSessionId: string | undefined;
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
    ): void {
        const adapter = this.d.getAdapter(backend);
        if (!adapter || adapter.canStartSessions === false) {
            return;
        }
        const options: SessionStartOptions = {
            cwd,
            model: undefined,
            permission: undefined,
            env: {},
            parentId,
            handoff: { sessionId: parentId, backend: fromName, title },
        };
        this.d.openDialogue(backend, options, title);
        this.d.post({
            type: "set-input",
            text: `Continue the parent conversation${parentId ? ` (${parentId})` : ""}.`,
        });
    }

    /**
     * Hands off a live ChatController session to a new backend.
     * Replays the entire transcript as if it happened on the new agent.
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
        this.openDialogueSeeded(backend, from.cwd, from.title, fromName, sourceSessionId);
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
