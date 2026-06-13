import * as vscode from "vscode";
import { AgentAdapter, FollowHandle, HistoryMessage, SessionInfo } from "../adapters/types";

export interface TerminalSessionOptions {
    cwd: string;
    /** Resume an existing session id instead of starting fresh. */
    resumeSessionId?: string;
    model?: string;
    /** Extra environment for the launched CLI (gateway routing, etc.). */
    env?: Record<string, string>;
    /**
     * When set, the CLI runs inside a detached tmux session of this name
     * (`tmux new-session -A -s <name>`). The agent then survives VS Code
     * closing and is recovered live by re-attaching to the same name.
     */
    tmuxName?: string;
}

/**
 * A session whose process Symposium owns inside a visible VS Code
 * integrated terminal. The user sees and can type in the real terminal;
 * the chat composer drives the same process via `terminal.sendText`, and
 * the conversation is rendered by tailing the transcript the CLI writes.
 *
 * This is the only way to truly two-way control a live interactive
 * session — Symposium launches it, so it owns stdin.
 */
export class TerminalSession {
    private terminal: vscode.Terminal | undefined;
    private follow: FollowHandle | undefined;
    private sessionId: string | undefined;
    private booted = false;
    private readonly pending: string[] = [];
    private disposed = false;

    constructor(
        private readonly adapter: AgentAdapter,
        private readonly options: TerminalSessionOptions,
        private readonly post: (message: unknown) => void,
        private readonly log: (message: string) => void,
    ) { }

    /** Launches the terminal, discovers the session id, then starts mirroring. */
    async start(): Promise<void> {
        const knownBefore = new Set((await this.listOwnCwdSessions()).map((s) => s.sessionId));

        const env: Record<string, string> = { ...this.options.env };
        this.terminal = vscode.window.createTerminal({
            name: `Symposium · ${this.adapter.backend}`,
            cwd: this.options.cwd,
            env: Object.keys(env).length ? env : undefined,
        });
        this.terminal.show(true);

        const args: string[] = [];
        if (this.options.model) {
            args.push("--model", this.options.model);
        }
        if (this.options.resumeSessionId) {
            args.push("--resume", this.options.resumeSessionId);
            this.sessionId = this.options.resumeSessionId;
        }
        const cli = `${this.adapter.backend === "claude" ? "claude" : this.adapter.backend} ${args.join(" ")}`.trim();
        // Persistent mode: run the CLI inside a detached tmux session that
        // survives VS Code. `-A` attaches to it if it already exists (recovery
        // of a live process), or creates it on first launch.
        const cmd = this.options.tmuxName
            ? `tmux new-session -A -s ${shellQuote(this.options.tmuxName)} ${shellQuote(cli)}`
            : cli;
        this.log(`[terminal] launch: ${cmd} (cwd=${this.options.cwd})`);
        this.terminal.sendText(cmd, true);

        // A resumed session already has its id; a fresh one appears as a new
        // transcript shortly after the CLI boots.
        if (this.sessionId) {
            this.attachFollow();
            this.markBooted();
        } else {
            void this.discoverSessionId(knownBefore);
        }
    }

    /** Drives the running process: feeds the composer text into the terminal. */
    send(text: string): void {
        this.post({ type: "user", text });
        if (!this.booted) {
            this.pending.push(text);
            return;
        }
        this.feed(text);
    }

    private feed(text: string): void {
        // Send the prompt then submit. A small delay lets the TUI register the
        // pasted text before the Enter, avoiding a swallowed first character.
        this.terminal?.sendText(text, false);
        setTimeout(() => this.terminal?.sendText("", true), 60);
    }

    private markBooted(): void {
        this.booted = true;
        for (const text of this.pending.splice(0)) {
            this.feed(text);
        }
    }

    private async discoverSessionId(knownBefore: Set<string>): Promise<void> {
        const deadline = Date.now() + 30_000;
        const tick = async () => {
            if (this.disposed) {
                return;
            }
            const sessions = await this.listOwnCwdSessions();
            const fresh = sessions.find((s) => !knownBefore.has(s.sessionId));
            if (fresh) {
                this.sessionId = fresh.sessionId;
                this.log(`[terminal] discovered session ${fresh.sessionId}`);
                this.post({ type: "event", event: { kind: "session", sessionId: fresh.sessionId } });
                this.attachFollow();
                this.markBooted();
                return;
            }
            if (Date.now() < deadline) {
                setTimeout(() => void tick(), 800);
            } else {
                this.log("[terminal] session id not discovered within timeout; type in the terminal to start it");
                // Let the user drive the terminal directly; mirror attaches on next try.
                this.markBooted();
            }
        };
        setTimeout(() => void tick(), 800);
    }

    private attachFollow(): void {
        if (!this.sessionId || !this.adapter.follow) {
            return;
        }
        const info: SessionInfo = { backend: this.adapter.backend, sessionId: this.sessionId, title: "" };
        // Seed with whatever already exists, then tail.
        if (this.adapter.history) {
            void this.adapter.history(info).then((messages: HistoryMessage[]) => {
                if (!this.disposed) {
                    this.post({ type: "history", messages });
                }
            });
        }
        this.follow = this.adapter.follow(info, (message) => {
            this.post({ type: "append", message });
        });
    }

    private async listOwnCwdSessions(): Promise<SessionInfo[]> {
        if (!this.adapter.listSessions) {
            return [];
        }
        const all = await this.adapter.listSessions().catch(() => [] as SessionInfo[]);
        return all.filter((s) => s.cwd === this.options.cwd);
    }

    dispose(): void {
        this.disposed = true;
        this.follow?.dispose();
        this.follow = undefined;
        // Leave the terminal open so the user keeps their session; just detach.
        this.terminal = undefined;
    }
}

/** Minimal POSIX single-quote escaping for a shell argument. */
function shellQuote(value: string): string {
    return `'${value.replace(/'/g, "'\\''")}'`;
}
