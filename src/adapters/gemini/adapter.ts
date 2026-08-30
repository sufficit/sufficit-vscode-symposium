import * as fs from "node:fs";
import {
    AgentAdapter,
    AgentSession,
    HistoryPage,
    SessionInfo,
    SessionStartOptions,
} from "../types";
import { EmptyAdapterUsage } from "../quotaCache";
import {
    defaultGeminiRoots,
    GeminiDiscoveryOptions,
    GeminiSessionSource,
    listGeminiSessions,
} from "./sessionDiscovery";
import { readGeminiHistory } from "./transcript";

/**
 * Discovery-only integration for conversations owned by Gemini CLI or
 * Antigravity. These tools do not expose a supported resume transport to
 * Symposium, so stored sessions are intentionally opened read-only.
 */
export class GeminiAdapter implements AgentAdapter {
    readonly canStartSessions = false;
    readonly displayName: string;
    readonly usage: EmptyAdapterUsage;

    constructor(
        readonly backend: GeminiSessionSource = "gemini",
        private readonly roots: NonNullable<GeminiDiscoveryOptions["roots"]> = defaultGeminiRoots(),
    ) {
        this.displayName = backend === "antigravity" ? "Antigravity" : "Gemini";
        this.usage = new EmptyAdapterUsage(
            backend,
            this.displayName,
            `${this.displayName} transcripts do not expose account usage limits.`,
        );
    }

    async available(): Promise<{ ok: boolean; version?: string; error?: string }> {
        const root = this.roots[this.backend];
        try {
            const stat = await fs.promises.stat(root);
            return stat.isDirectory()
                ? { ok: true, version: "history (read-only)" }
                : { ok: false, error: `${root} is not a directory` };
        } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
    }

    listSessions(): Promise<SessionInfo[]> {
        return listGeminiSessions([], { roots: this.roots, sources: [this.backend] });
    }

    listSessionsIncremental(cached: readonly SessionInfo[]): Promise<SessionInfo[]> {
        return listGeminiSessions(cached, { roots: this.roots, sources: [this.backend] });
    }

    async history(info: SessionInfo): Promise<HistoryPage> {
        return {
            messages: info.transcriptPath ? await readGeminiHistory(info.transcriptPath) : [],
        };
    }

    start(_options: SessionStartOptions): AgentSession {
        throw new Error(`${this.displayName} sessions are available as read-only history.`);
    }
}
