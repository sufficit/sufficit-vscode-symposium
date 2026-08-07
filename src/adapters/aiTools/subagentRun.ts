import type { ToolContext } from "./types";

const NAMES = new Set(["spawn_agent", "list_agents", "agent_status", "agent_send", "agent_stop"]);

export async function runSubagentTool(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolContext,
): Promise<string | undefined> {
    if (!NAMES.has(name)) return undefined;
    const host = ctx.subagents;
    if (!host) return JSON.stringify({ error: "subagents unavailable (live runtime not ready)" });
    if (name === "list_agents") return JSON.stringify({ agents: host.list(ctx.sessionId) });
    if (name === "agent_status") {
        return JSON.stringify(host.status(String(args.id ?? "")) ?? { error: "no such subagent" });
    }
    if (name === "agent_send") {
        const ok = host.send(String(args.id ?? ""), String(args.text ?? ""));
        return JSON.stringify({
            ok,
            error: ok ? undefined : "no such subagent (or it was stopped)",
        });
    }
    if (name === "agent_stop") {
        const ok = host.stop(String(args.id ?? ""));
        return JSON.stringify({ ok, error: ok ? undefined : "no such subagent" });
    }
    const background = args.background === true;
    const status = await host.spawn({
        agent: String(args.agent ?? ""),
        task: String(args.task ?? ""),
        backend: args.backend ? String(args.backend) : undefined,
        model: args.model ? String(args.model) : undefined,
        cwd: ctx.cwd,
        background,
        permission: ctx.permission,
        parentSessionId: ctx.sessionId,
        parentBackend: ctx.parentBackend,
    });
    if (status.error && status.status === "gone") return JSON.stringify({ error: status.error });
    ctx.progress?.onNotify?.(
        `spawned ${status.agent} (${status.backend})${background ? " in background" : ""}`,
    );
    return JSON.stringify(status);
}
