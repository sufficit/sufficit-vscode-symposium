import { AgentAdapter, SessionStartOptions } from "../adapters/types";
import { aiToolsForAgent } from "../adapters/aiTools/defs";
import { SubagentHandle, SubagentHost, SubagentStatus } from "../adapters/aiTools/types";
import { readAgentBackend, readAgentBody, readAgentModel, readAgentTools } from "../config/root";
import { ChatController } from "../ui/chatController";
import { LiveSessions } from "./runtime";

/**
 * Spawns and controls subagents as real Symposium sessions, so an agent can
 * delegate a task to a synced agent-def and run it foreground (await its result)
 * or background (detached, polled via the agent_* tools). Each subagent is a
 * regular ChatController in the live runtime — it appears in the sessions list
 * (nested under its parent) and is steered with the same send/interrupt path.
 *
 * Backend/model resolution, in order (if specified, obeyed exactly):
 *   1. the spawn call's `backend`/`model` argument,
 *   2. else the agent-def's `backend:` / `model:` frontmatter preference,
 *   3. else the parent conversation's backend (model: the backend default).
 * A def constraint may be a name, comma-list, or wildcard (e.g. `gpt-*`); the
 * resolved value must match it or the spawn is rejected.
 */

const MAX_OUTPUT = 30000;
const MAX_CONCURRENT = 4;
const MAX_DEPTH = 2;

interface Rec {
    id: string;
    key: string;
    agent: string;
    backend: string;
    title: string;
    controller: ChatController;
    output: string;
    steps: number;
    status: "working" | "idle" | "gone";
    error?: string;
    parentSessionId?: string;
    depth: number;
    unsub: () => void;
    waiters: ((s: SubagentStatus) => void)[];
}

/** Splits a `a, b, c` constraint string into trimmed, non-empty patterns. */
function parseList(s: string): string[] {
    return s.split(",").map((x) => x.trim()).filter(Boolean);
}

function isWildcard(p: string): boolean {
    return /[*?]/.test(p);
}

/** Glob-style match: `*` → any run, `?` → one char. Case-insensitive, anchored. */
function matchWildcard(pattern: string, value: string): boolean {
    const re = new RegExp(
        "^" + pattern.trim().replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$",
        "i",
    );
    return re.test(value);
}

/** True when `value` satisfies a (possibly multi-pattern, wildcard) constraint. */
function matchAny(constraint: string, value: string): boolean {
    const ps = parseList(constraint);
    if (!ps.length) { return true; }
    return ps.some((p) => p === "*" || matchWildcard(p, value));
}

/** First concrete (non-wildcard) token of a constraint, if any. */
function firstConcrete(constraint: string): string | undefined {
    return parseList(constraint).find((p) => !isWildcard(p));
}

export class SubagentManager implements SubagentHost {
    private readonly recs = new Map<string, Rec>();

    constructor(
        private readonly live: LiveSessions,
        private readonly adapterByBackend: Map<string, AgentAdapter>,
        /** Foreground wait ceiling; past it the run keeps going in the background. */
        private readonly timeoutMs: () => number = () => 300000,
    ) { }

    async spawn(opts: {
        agent: string; task: string; backend?: string; model?: string;
        cwd: string; background: boolean; parentSessionId?: string; parentBackend?: string;
    }): Promise<SubagentStatus> {
        const agent = String(opts.agent ?? "").trim();
        const task = String(opts.task ?? "").trim();
        if (!agent) { return this.err("", agent, "", "agent name is required"); }
        if (!task) { return this.err("", agent, "", "task is required"); }

        // Depth + concurrency guards keep a delegation tree bounded.
        const parentDepth = opts.parentSessionId ? (this.recs.get(opts.parentSessionId)?.depth ?? 0) : 0;
        const depth = parentDepth + 1;
        if (depth > MAX_DEPTH) {
            return this.err("", agent, "", `max subagent depth (${MAX_DEPTH}) reached — this agent is already a subagent`);
        }
        const active = [...this.recs.values()].filter((r) => r.status === "working").length;
        if (active >= MAX_CONCURRENT) {
            return this.err("", agent, "", `too many active subagents (${active}/${MAX_CONCURRENT}); wait or agent_stop one first`);
        }

        // Resolve backend against the def constraint + arg + parent fallback.
        const defBackend = readAgentBackend(agent);
        const requested = String(opts.backend ?? "").trim();
        const backend = requested || firstConcrete(defBackend) || opts.parentBackend || "openai";
        if (defBackend && !matchAny(defBackend, backend)) {
            return this.err("", agent, backend, `agent '${agent}' restricts backend to '${defBackend}'; '${backend}' is not allowed`);
        }
        const adapter = this.adapterByBackend.get(backend);
        if (!adapter) { return this.err("", agent, backend, `unknown backend '${backend}'`); }

        // Resolve model the same way (def pin / arg, wildcard-validated).
        const defModel = readAgentModel(agent);
        const reqModel = String(opts.model ?? "").trim();
        const model = reqModel || firstConcrete(defModel) || undefined;
        if (defModel && model && !matchAny(defModel, model)) {
            return this.err("", agent, backend, `agent '${agent}' restricts model to '${defModel}'; '${model}' is not allowed`);
        }

        const options: SessionStartOptions = {
            cwd: opts.cwd,
            developerPrompt: readAgentBody(agent),
            aiTools: aiToolsForAgent(readAgentTools(agent)),
            agentName: agent,
            parentId: opts.parentSessionId,
            ...(model ? { model } : {}),
        };
        const { key, controller } = this.live.createWithKey(adapter, options);
        const id = controller.sessionId ?? key;
        const rec: Rec = {
            id, key, agent, backend, title: `Subagent: ${agent}`, controller,
            output: "", steps: 0, status: "working", parentSessionId: opts.parentSessionId,
            depth, unsub: () => { }, waiters: [],
        };
        rec.unsub = controller.subscribe((m) => this.onMessage(rec, m));
        this.recs.set(id, rec);
        controller.sendText(task);

        if (opts.background) { return this.snapshot(rec); }
        return this.waitIdle(rec, this.timeoutMs());
    }

    status(id: string): SubagentStatus | undefined {
        const rec = this.find(id);
        return rec ? this.snapshot(rec) : undefined;
    }

    send(id: string, text: string): boolean {
        const rec = this.find(id);
        if (!rec || rec.status === "gone") { return false; }
        rec.status = "working";
        rec.controller.sendText(String(text ?? ""));
        return true;
    }

    stop(id: string): boolean {
        const rec = this.find(id);
        if (!rec) { return false; }
        rec.controller.interrupt();
        this.live.disposeBySessionId(rec.controller.sessionId ?? rec.key);
        rec.status = "gone";
        rec.unsub();
        this.flush(rec);
        return true;
    }

    list(parentSessionId?: string): SubagentHandle[] {
        return [...this.recs.values()]
            .filter((r) => r.status !== "gone" && (!parentSessionId || r.parentSessionId === parentSessionId))
            .map((r) => ({ id: r.id, agent: r.agent, backend: r.backend, status: r.status, title: r.title }));
    }

    /** Accumulate output/steps and resolve foreground waiters on turn end. */
    private onMessage(rec: Rec, m: unknown): void {
        const msg = m as { type?: string; event?: { kind?: string; text?: string; message?: string } };
        if (!msg || msg.type !== "event" || !msg.event) { return; }
        const ev = msg.event;
        if (ev.kind === "text" && typeof ev.text === "string") {
            rec.output = (rec.output + ev.text).slice(-MAX_OUTPUT);
        } else if (ev.kind === "tool-start") {
            rec.steps++;
        } else if (ev.kind === "error" && ev.message) {
            rec.error = rec.error ?? String(ev.message);
        } else if (ev.kind === "turn-end") {
            // The backend assigns the real session id during the first turn; adopt
            // it so the returned id keeps addressing this subagent after it lands.
            const sid = rec.controller.sessionId;
            if (sid && sid !== rec.id) {
                this.recs.delete(rec.id);
                rec.id = sid;
                this.recs.set(sid, rec);
            }
            if (rec.status !== "gone") { rec.status = "idle"; }
            this.flush(rec);
        }
    }

    private waitIdle(rec: Rec, timeoutMs: number): Promise<SubagentStatus> {
        if (rec.status !== "working") { return Promise.resolve(this.snapshot(rec)); }
        return new Promise((resolve) => {
            const waiter = (s: SubagentStatus) => { clearTimeout(timer); resolve(s); };
            const timer = setTimeout(() => {
                const i = rec.waiters.indexOf(waiter);
                if (i >= 0) { rec.waiters.splice(i, 1); }
                // Timed out waiting: leave it running and return the partial state so
                // the caller can keep polling with agent_status.
                resolve({ ...this.snapshot(rec), error: rec.error ?? "foreground wait timed out — still running in the background" });
            }, Math.max(1000, timeoutMs));
            rec.waiters.push(waiter);
        });
    }

    private flush(rec: Rec): void {
        const snap = this.snapshot(rec);
        rec.waiters.splice(0).forEach((w) => w(snap));
    }

    private find(id: string): Rec | undefined {
        const key = String(id ?? "");
        return this.recs.get(key)
            ?? [...this.recs.values()].find((r) => r.key === key || r.controller.sessionId === key);
    }

    private snapshot(rec: Rec): SubagentStatus {
        return { id: rec.id, agent: rec.agent, backend: rec.backend, status: rec.status, output: rec.output, steps: rec.steps, error: rec.error };
    }

    private err(id: string, agent: string, backend: string, error: string): SubagentStatus {
        return { id, agent, backend, status: "gone", output: "", steps: 0, error };
    }
}
