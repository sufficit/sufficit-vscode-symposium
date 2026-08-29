import { EventEmitter } from "events";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
    AgentAdapter,
    AgentSession,
    SessionInfo,
    SessionStartOptions,
    SlashCommand,
} from "../types";
import { listGeminiSessions } from "./sessionDiscovery";
import { geminiUsage } from "./usage";

export class GeminiSession extends EventEmitter implements AgentSession {
    readonly backend = "gemini" as const;
    readonly sessionId: string | undefined;

    constructor(options: SessionStartOptions) {
        super();
        this.sessionId = options.resumeSessionId;
    }

    send(text: string): void {
        this.emit("event", {
            kind: "text",
            text: `[Gemini/Antigravity integration: read-only/managed outside VS Code] ${text}`,
        });
    }

    cancel(): void {}

    dispose(): void {
        this.removeAllListeners();
    }
}

export class GeminiAdapter implements AgentAdapter {
    readonly backend = "gemini" as const;
    readonly displayName = "Gemini";
    readonly usage = geminiUsage;

    async available(): Promise<{ ok: boolean; version?: string; error?: string }> {
        const geminiDir = path.join(os.homedir(), ".gemini");
        try {
            const stat = await fs.promises.stat(geminiDir);
            return { ok: stat.isDirectory(), version: "antigravity" };
        } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
    }

    async listSessions(): Promise<SessionInfo[]> {
        return listGeminiSessions([]);
    }

    async listSessionsIncremental(cached: readonly SessionInfo[]): Promise<SessionInfo[]> {
        return listGeminiSessions(cached);
    }

    start(options: SessionStartOptions): AgentSession {
        return new GeminiSession(options);
    }

    models(): string[] {
        return ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.0-flash"];
    }

    commands(): Promise<SlashCommand[]> {
        return Promise.resolve([]);
    }
}
