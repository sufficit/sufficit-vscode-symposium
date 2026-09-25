import { spawn } from "node:child_process";
import { EmptyAdapterUsage } from "../quotaCache";
import type { AgentAdapter, AgentSession, SessionInfo, SessionStartOptions } from "../types";
import { resolveGeniusExecutable } from "./executable";
import { GeniusSession, type GeniusAdapterConfig } from "./session";

interface CliResponse {
    schemaVersion: number;
    type: string;
    status: string;
    data?: Record<string, unknown>;
    error?: string | null;
}

function isUuid(value: unknown): value is string {
    return (
        typeof value === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    );
}

/** Bounded CLI command; prompts always use the streaming GeniusSession. */
function queryCli(config: GeniusAdapterConfig, args: string[]): Promise<CliResponse> {
    return new Promise((resolve, reject) => {
        const child = spawn(resolveGeniusExecutable(config.executable), args, {
            env: { ...process.env, ...config.env },
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        let settled = false;
        const finish = (error?: Error, response?: CliResponse) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            if (error) reject(error);
            else resolve(response!);
        };
        const timeout = setTimeout(() => {
            child.kill("SIGTERM");
            finish(new Error(`Genius CLI ${args[0]} timed out`));
        }, 15_000);
        child.stdout.on("data", (chunk) => {
            stdout += String(chunk);
            if (stdout.length > 4_000_000) {
                child.kill("SIGTERM");
                finish(new Error("Genius CLI response exceeded 4 MB"));
            }
        });
        child.stderr.on("data", (chunk) => {
            stderr = (stderr + String(chunk)).slice(-2000);
        });
        child.on("error", (error) => finish(error));
        child.on("close", (code) => {
            if (settled) return;
            let response: CliResponse;
            try {
                response = JSON.parse(stdout.trim()) as CliResponse;
            } catch {
                finish(new Error(`Genius CLI returned invalid JSON: ${stderr.trim()}`));
                return;
            }
            if (response.schemaVersion !== 1) {
                finish(
                    new Error(`Unsupported Genius CLI protocol version: ${response.schemaVersion}`),
                );
            } else if (code !== 0) {
                finish(
                    new Error(
                        response.error || stderr.trim() || `Genius CLI exited with code ${code}`,
                    ),
                );
            } else {
                finish(undefined, response);
            }
        });
    });
}

export class GeniusAdapter implements AgentAdapter {
    readonly backend = "genius";
    readonly displayName = "Genius";
    readonly usage = new EmptyAdapterUsage(
        "genius",
        "Genius",
        "Genius CLI does not expose account quota windows.",
    );

    constructor(private readonly getConfig: () => GeniusAdapterConfig) {}

    async available(): Promise<{ ok: boolean; version?: string; error?: string }> {
        try {
            const response = await queryCli(this.getConfig(), ["--version", "--json"]);
            if (response.type !== "version" || response.status !== "ok") {
                throw new Error("Genius CLI returned an unexpected version response");
            }
            return { ok: true, version: String(response.data?.version ?? "unknown") };
        } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
    }

    async listSessions(): Promise<SessionInfo[]> {
        const response = await queryCli(this.getConfig(), ["sessions", "--json"]);
        if (
            response.type !== "sessions" ||
            response.status !== "ok" ||
            !Array.isArray(response.data?.sessions)
        ) {
            throw new Error("Genius CLI returned an invalid sessions response");
        }
        return response.data.sessions.flatMap((raw): SessionInfo[] => {
            if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return [];
            const entry = raw as Record<string, unknown>;
            if (!isUuid(entry.sessionId)) return [];
            return [
                {
                    backend: this.backend,
                    backendName: this.displayName,
                    sessionId: entry.sessionId,
                    title:
                        typeof entry.title === "string" && entry.title.trim()
                            ? entry.title
                            : "Genius session",
                    model:
                        typeof entry.presetId === "string" && entry.presetId
                            ? entry.presetId
                            : undefined,
                },
            ];
        });
    }

    async listSessionsIncremental(cached: readonly SessionInfo[]): Promise<SessionInfo[]> {
        try {
            const existing = new Map(cached.map((session) => [session.sessionId, session]));
            return (await this.listSessions()).map((session) => ({
                ...existing.get(session.sessionId),
                ...session,
                updatedAt: existing.get(session.sessionId)?.updatedAt,
            }));
        } catch {
            return [...cached];
        }
    }

    async deleteSession(info: SessionInfo): Promise<void> {
        if (!isUuid(info.sessionId)) throw new Error("Genius session ID is not a valid UUID.");
        const response = await queryCli(this.getConfig(), ["delete", info.sessionId, "--json"]);
        if (
            response.type !== "session/deleted" ||
            response.status !== "completed" ||
            response.data?.sessionId !== info.sessionId
        ) {
            throw new Error("Genius CLI did not confirm session deletion");
        }
    }

    start(options: SessionStartOptions): AgentSession {
        return new GeniusSession(this.getConfig(), options);
    }

    models(): string[] {
        const configured = this.getConfig().model;
        return configured ? [configured] : [];
    }

    hasNativeTodo(): boolean {
        return true;
    }
}
