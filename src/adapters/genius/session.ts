import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import * as readline from "node:readline";
import type { AgentEvent, AgentSession, SessionStartOptions } from "../types";
import { GeniusEventParser } from "./eventParser";
import { resolveGeniusExecutable } from "./executable";

export interface GeniusAdapterConfig {
    executable: string;
    model: string;
    env?: Record<string, string>;
}

/** Runs one `genius exec --stdin --json` child for each turn. Genius owns context. */
export class GeniusSession extends EventEmitter implements AgentSession {
    readonly backend = "genius";
    sessionId: string | undefined;
    private current: ChildProcessWithoutNullStreams | undefined;
    private currentTurnId: string | undefined;
    private sequence = 0;
    private disposed = false;
    private cancelled = false;
    private reportedError = false;
    private presetId: string;

    constructor(
        private readonly config: GeniusAdapterConfig,
        private readonly options: SessionStartOptions,
    ) {
        super();
        this.sessionId = options.resumeSessionId;
        this.presetId = options.model || config.model;
    }

    setModel(model: string): void {
        this.presetId = model === "default" ? this.config.model : model;
    }

    getModel(): string {
        return this.presetId;
    }

    send(
        text: string,
        images?: string[],
        _preamble?: string[],
        intentId?: string,
        retryOf?: string,
    ): void {
        if (this.disposed) return;
        if (this.current) {
            const previousTurn = this.currentTurnId;
            this.current.kill("SIGINT");
            this.current = undefined;
            if (previousTurn) this.emitTurnEnd(previousTurn);
        }
        const turnId =
            retryOf && retryOf !== "retry"
                ? retryOf
                : `${this.sessionId ?? "genius"}/turn-${++this.sequence}`;
        this.currentTurnId = turnId;
        this.cancelled = false;
        this.reportedError = false;
        this.emit("event", {
            kind: "turn-start",
            logicalTurnId: turnId,
            intentId,
        } satisfies AgentEvent);

        if (images?.length) {
            this.failTurn("Genius CLI does not support image attachments yet.", turnId);
            return;
        }
        if (
            this.sessionId &&
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(this.sessionId)
        ) {
            this.failTurn("Genius session ID is not a valid UUID.", turnId);
            return;
        }

        const args = ["exec", "--stdin", "--json"];
        if (this.sessionId) args.push("--resume", this.sessionId);
        if (this.presetId) args.push("--preset", this.presetId);
        const child = spawn(resolveGeniusExecutable(this.config.executable), args, {
            cwd: this.options.cwd,
            env: { ...process.env, ...this.config.env, ...this.options.env },
            stdio: ["pipe", "pipe", "pipe"],
        });
        this.current = child;
        const parser = new GeniusEventParser({
            session: (id, presetId) => {
                if (this.current !== child) return;
                if (this.sessionId && this.sessionId !== id) {
                    this.failTurn("Genius CLI resumed a different session.", turnId);
                    child.kill("SIGTERM");
                    return;
                }
                this.sessionId = id;
                if (presetId) this.presetId = presetId;
                this.emit("event", {
                    kind: "session",
                    sessionId: id,
                    model: this.presetId || undefined,
                } satisfies AgentEvent);
            },
            emit: (event) => {
                if (this.current === child && !this.cancelled) this.emit("event", event);
            },
        });
        const lines = readline.createInterface({ input: child.stdout });
        lines.on("line", (line) => {
            if (this.current !== child || this.cancelled) return;
            try {
                parser.handleLine(line);
            } catch (error) {
                this.failTurn(error instanceof Error ? error.message : String(error), turnId);
                child.kill("SIGTERM");
            }
        });
        let stderr = "";
        child.stderr.on("data", (chunk) => {
            stderr = (stderr + String(chunk)).slice(-2000);
        });
        child.stdin.on("error", () => undefined);
        child.stdin.end(text);
        child.on("error", (error) => {
            if (this.current !== child) return;
            this.failTurn(`Genius CLI could not start: ${error.message}`, turnId);
        });
        child.on("close", (code) => {
            if (this.current !== child) return;
            this.current = undefined;
            if (this.disposed) return;
            if (!this.cancelled && !this.reportedError && !parser.sawError) {
                if (code !== 0) {
                    this.emit("event", {
                        kind: "error",
                        message: `Genius CLI exited with code ${code}: ${stderr.trim() || "no diagnostics"}`,
                        retryable: false,
                    } satisfies AgentEvent);
                } else if (!parser.sawResult) {
                    this.emit("event", {
                        kind: "error",
                        message: "Genius CLI ended without a result record.",
                        retryable: false,
                    } satisfies AgentEvent);
                }
            }
            this.cancelled = false;
            this.emitTurnEnd(turnId);
        });
    }

    cancel(): void {
        if (!this.current) return;
        this.cancelled = true;
        this.current.kill("SIGINT");
    }

    dispose(): void {
        this.disposed = true;
        this.current?.kill("SIGTERM");
        this.current = undefined;
        this.removeAllListeners();
    }

    private failTurn(message: string, turnId: string): void {
        this.reportedError = true;
        this.emit("event", { kind: "error", message, retryable: false } satisfies AgentEvent);
        if (!this.current) this.emitTurnEnd(turnId);
    }

    private emitTurnEnd(turnId: string): void {
        if (this.currentTurnId !== turnId) return;
        this.currentTurnId = undefined;
        this.emit("event", { kind: "turn-end", logicalTurnId: turnId } satisfies AgentEvent);
    }
}
