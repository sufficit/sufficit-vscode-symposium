import { EventEmitter } from "events";
import {
    AgentAdapter,
    AgentBackend,
    AgentSession,
    SessionInfo,
    SessionStartOptions,
} from "./types";

/**
 * Placeholder adapter for backends not yet implemented.
 *
 * Codex CLI: will use `codex exec --json` (JSONL events) and
 * `codex exec resume <id>`; sessions live in ~/.codex/sessions.
 *
 * Copilot CLI: exposes `--acp` (Agent Client Protocol, JSON-RPC over
 * stdio) which is the planned integration path; `copilot -p` with
 * `--resume` is the fallback.
 */
class StubSession extends EventEmitter implements AgentSession {
    sessionId: string | undefined;

    constructor(readonly backend: AgentBackend) {
        super();
    }

    send(_text: string): void {
        this.emit("event", {
            kind: "error",
            message: `${this.backend} adapter is not implemented yet`,
        });
        this.emit("event", { kind: "turn-end" });
    }

    cancel(): void { }
    dispose(): void {
        this.removeAllListeners();
    }
}

export class StubAdapter implements AgentAdapter {
    constructor(readonly backend: AgentBackend) { }

    async available(): Promise<{ ok: boolean; error?: string }> {
        return { ok: false, error: "not implemented" };
    }

    async listSessions(): Promise<SessionInfo[]> {
        return [];
    }

    start(_options: SessionStartOptions): AgentSession {
        return new StubSession(this.backend);
    }
}
