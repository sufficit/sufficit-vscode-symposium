import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import * as readline from "node:readline";
import type { AgentEvent, AgentSession, SessionStartOptions } from "../types";
import { resolveSufficitMcpToken } from "../sufficitMcp";
import { runQueueCommand, stopSession } from "./cliCommands";
import { GeniusEventParser } from "./eventParser";
import { resolveGeniusExecutable } from "./executable";
import type { GeniusMcpServer } from "./mcpConfig";
import { explicitPreset } from "./presetState";

export interface GeniusAdapterConfig {
    executable: string;
    model: string;
    env?: Record<string, string>;
    tokenProvider?: () => Promise<string | null>;
    contextWindows?: Record<string, number>;
    mcpServers?: () => GeniusMcpServer[];
}

interface ExecProcess {
    child: ChildProcessWithoutNullStreams;
    parser: GeniusEventParser;
    clientMessageId?: string;
    buffered: AgentEvent[];
    activeTurnId?: string;
    finished: boolean;
    exitCode: number | null;
    stderr: string;
    accepted: Promise<void>;
    confirmAccepted(): void;
    sawQueued: boolean;
}

/** Runs one `genius exec --input-json --json` child for each turn. Genius owns context. */
export class GeniusSession extends EventEmitter implements AgentSession {
    readonly backend = "genius";
    sessionId: string | undefined;
    private current: ChildProcessWithoutNullStreams | undefined;
    private currentProcess: ExecProcess | undefined;
    private readonly prequeued = new Map<string, Promise<ExecProcess>>();
    private currentTurnId: string | undefined;
    private sequence = 0;
    private disposed = false;
    private cancelled = false;
    private reportedError = false;
    private presetId: string;
    /** Bumped on every explicit setModel(); guards a late "session" record
     *  from a process launched before the change from reverting it. */
    private presetRevision = 0;

    constructor(
        private readonly config: GeniusAdapterConfig,
        private readonly options: SessionStartOptions,
    ) {
        super();
        this.sessionId = options.resumeSessionId;
        this.presetId = explicitPreset(options.model || config.model);
    }

    setModel(model: string): void {
        this.presetId = explicitPreset(model === "default" ? this.config.model : model);
        this.presetRevision++;
    }

    getModel(): string {
        return this.presetId;
    }

    send(
        text: string,
        images?: string[],
        preamble?: string[],
        intentId?: string,
        retryOf?: string,
        clientMessageId?: string,
    ): void {
        if (this.disposed) return;
        if (this.current) {
            const previousTurn = this.currentTurnId;
            this.stopHostTurn();
            this.current = undefined;
            this.currentProcess = undefined;
            if (previousTurn) this.emitTurnEnd(previousTurn);
        } else if (this.currentTurnId) {
            this.emitTurnEnd(this.currentTurnId);
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

        const queued = clientMessageId && this.prequeued.get(clientMessageId);
        if (queued) {
            void queued
                .then((process) => {
                    if (this.disposed || this.currentTurnId !== turnId) return;
                    this.prequeued.delete(clientMessageId);
                    this.activate(process, turnId);
                })
                .catch((error) => this.failTurn(String(error), turnId));
        } else {
            void this.startTurn(text, preamble ?? [], turnId, clientMessageId);
        }
    }
    prequeue(text: string, preamble: string[], clientMessageId: string, model?: string): void {
        if (this.disposed || !this.sessionId || this.prequeued.has(clientMessageId)) return;
        const promise = this.launchExec(
            text,
            preamble,
            clientMessageId,
            explicitPreset(model || this.presetId),
        );
        this.prequeued.set(clientMessageId, promise);
        void promise.catch((error) => {
            this.prequeued.delete(clientMessageId);
            this.emit("native-queue-error", clientMessageId, String(error));
        });
    }
    removePrequeued(clientMessageId: string): void {
        void this.queueCommand("remove", clientMessageId);
    }

    promotePrequeued(clientMessageId: string): void {
        void this.queueCommand("promote", clientMessageId);
    }

    private async startTurn(
        text: string,
        instructions: string[],
        turnId: string,
        clientMessageId?: string,
    ): Promise<void> {
        try {
            const process = await this.launchExec(
                text,
                instructions,
                clientMessageId,
                this.presetId,
            );
            if (this.disposed || this.cancelled || this.currentTurnId !== turnId) {
                process.child.kill("SIGTERM");
                return;
            }
            this.activate(process, turnId);
        } catch (error) {
            if (this.currentTurnId === turnId && !this.disposed)
                this.failTurn(`Genius CLI could not start: ${String(error)}`, turnId);
        }
    }

    private async launchExec(
        text: string,
        instructions: string[],
        clientMessageId: string | undefined,
        presetId: string,
    ): Promise<ExecProcess> {
        const launchedRevision = this.presetRevision;
        const token = await (this.config.tokenProvider ?? resolveSufficitMcpToken)();
        const args = ["exec", "--input-json", "--json"];
        if (this.sessionId) args.push("--resume", this.sessionId);
        if (presetId) args.push("--preset", presetId);
        const env = { ...process.env, ...this.config.env, ...this.options.env };
        delete env.GENIUS_CLI_ACCESS_TOKEN;
        delete env.GENIUS_CLI_MCP_SERVERS_JSON;
        if (token) env.GENIUS_CLI_ACCESS_TOKEN = token;
        const servers = (this.config.mcpServers?.() ?? []).map((server) =>
            server.transport === "stdio"
                ? { ...server, workingDirectory: this.options.cwd }
                : server,
        );
        if (servers.length > 0) env.GENIUS_CLI_MCP_SERVERS_JSON = JSON.stringify(servers);
        const child = spawn(resolveGeniusExecutable(this.config.executable), args, {
            cwd: this.options.cwd,
            env,
            stdio: ["pipe", "pipe", "pipe"],
        });
        let confirmAccepted!: () => void;
        const accepted = new Promise<void>((resolve) => {
            confirmAccepted = resolve;
        });
        const running: ExecProcess = {
            child,
            parser: undefined!,
            clientMessageId,
            buffered: [],
            finished: false,
            exitCode: null,
            stderr: "",
            accepted,
            confirmAccepted,
            sawQueued: false,
        };
        const deliver = (event: AgentEvent) => {
            if (running.activeTurnId && !this.cancelled && this.currentProcess === running)
                this.emit("event", event);
            else running.buffered.push(event);
        };
        running.parser = new GeniusEventParser({
            contextWindow: (model) =>
                this.config.contextWindows?.[model || ""] ?? this.config.contextWindows?.[presetId],
            session: (id, reportedPreset) => {
                if (this.sessionId && this.sessionId !== id) {
                    deliver({
                        kind: "error",
                        message: "Genius CLI resumed a different session.",
                        retryable: false,
                    });
                    child.kill("SIGTERM");
                    return;
                }
                this.sessionId = id;
                if (reportedPreset && !presetId && this.presetRevision === launchedRevision)
                    this.presetId = reportedPreset;
                deliver({
                    kind: "session",
                    sessionId: id,
                    model: presetId || reportedPreset || undefined,
                });
            },
            emit: deliver,
        });
        const lines = readline.createInterface({ input: child.stdout });
        lines.on("line", (line) => {
            try {
                const record = JSON.parse(line) as { type?: string };
                if (record.type === "queued") {
                    running.sawQueued = true;
                    running.confirmAccepted();
                }
                running.parser.handleLine(line);
            } catch (error) {
                deliver({ kind: "error", message: String(error), retryable: false });
                child.kill("SIGTERM");
            }
        });
        child.stderr.on("data", (chunk) => {
            running.stderr = (running.stderr + String(chunk)).slice(-2000);
        });
        child.stdin.on("error", () => undefined);
        child.stdin.end(
            JSON.stringify({ schemaVersion: 1, prompt: text, instructions, clientMessageId }),
        );
        child.on("error", (error) => {
            deliver({
                kind: "error",
                message: `Genius CLI could not start: ${error.message}`,
                retryable: false,
            });
        });
        child.on("close", (code) => {
            running.confirmAccepted();
            running.finished = true;
            running.exitCode = code;
            if (running.activeTurnId) this.finish(running);
            else if (running.parser.removed && clientMessageId) {
                this.prequeued.delete(clientMessageId);
                this.emit("native-queue-removed", clientMessageId);
            }
        });
        return running;
    }

    private activate(running: ExecProcess, turnId: string): void {
        this.current = running.child;
        this.currentProcess = running;
        running.activeTurnId = turnId;
        for (const event of running.buffered) this.emit("event", event);
        running.buffered.length = 0;
        if (running.finished) this.finish(running);
    }

    private finish(running: ExecProcess): void {
        if (this.currentProcess !== running || !running.activeTurnId) return;
        this.current = undefined;
        this.currentProcess = undefined;
        if (this.disposed) return;
        if (!this.cancelled && !this.reportedError && !running.parser.sawError) {
            if (running.exitCode !== 0) {
                this.emit("event", {
                    kind: "error",
                    message: `Genius CLI exited with code ${running.exitCode}: ${running.stderr.trim() || "no diagnostics"}`,
                    retryable: false,
                } satisfies AgentEvent);
            } else if (!running.parser.sawResult) {
                this.emit("event", {
                    kind: "error",
                    message: "Genius CLI ended without a result record.",
                    retryable: false,
                } satisfies AgentEvent);
            }
        }
        this.cancelled = false;
        this.emitTurnEnd(running.activeTurnId);
    }

    private async queueCommand(
        action: "remove" | "promote",
        clientMessageId: string,
    ): Promise<void> {
        const pending = this.prequeued.get(clientMessageId);
        if (!this.sessionId || !pending) return;
        let running: ExecProcess;
        try {
            running = await pending;
        } catch {
            return;
        }
        await running.accepted;
        if (!running.sawQueued) return;
        const error = await runQueueCommand(
            {
                executable: this.config.executable,
                cwd: this.options.cwd,
                env: { ...process.env, ...this.config.env, ...this.options.env },
            },
            action,
            this.sessionId,
            clientMessageId,
        );
        if (error) this.emit("native-queue-error", clientMessageId, error);
    }

    cancel(): void {
        if (!this.currentTurnId) return;
        this.cancelled = true;
        if (this.current) this.stopHostTurn();
        else this.emitTurnEnd(this.currentTurnId);
    }

    private stopHostTurn(): void {
        const target = this.current;
        if (!this.sessionId) {
            target?.kill("SIGINT");
            return;
        }
        stopSession(
            {
                executable: this.config.executable,
                cwd: this.options.cwd,
                env: { ...process.env, ...this.config.env, ...this.options.env },
            },
            this.sessionId,
            () => target?.kill("SIGINT"),
        );
    }

    dispose(): void {
        this.disposed = true;
        for (const id of this.prequeued.keys()) this.removePrequeued(id);
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
