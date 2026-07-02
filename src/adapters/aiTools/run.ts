import { fetchSessionTasks, markTaskDone, sessionTag } from "../../sync/tasks";
import { saveGuardrail, clearSessionGuardrails } from "../../sync/guardrails";
import { ToolContext } from "./types";
import { LocalMemory } from "./localMemory";
import { runLocalTool } from "./localRun";

/**
 * Executes one tool call. Returns a JSON string for the model.
 *
 * The local tool branches (web navigation, session read-back, per-workspace
 * bootstrap, and the host shell/filesystem tools) live in ./localRun; this
 * delegates there first and falls through to the memory/hub/subagent branches
 * when the name isn't a local tool.
 */
export async function runAiTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const hub = ctx.hub;
    const planMode = ctx.permission === "plan";
    try {
        // ---- local tools (web / session / bootstrap / shell / fs) ----
        const local = await runLocalTool(name, args, ctx);
        if (local !== undefined) { return local; }

        // ---- subagents (spawn + control) ----
        if (name === "spawn_agent" || name === "list_agents" || name === "agent_status" || name === "agent_send" || name === "agent_stop") {
            const host = ctx.subagents;
            if (!host) { return JSON.stringify({ error: "subagents unavailable (live runtime not ready)" }); }
            if (name === "list_agents") {
                return JSON.stringify({ agents: host.list(ctx.sessionId) });
            }
            if (name === "agent_status") {
                const st = host.status(String(args.id ?? ""));
                return JSON.stringify(st ?? { error: "no such subagent" });
            }
            if (name === "agent_send") {
                const ok = host.send(String(args.id ?? ""), String(args.text ?? ""));
                return JSON.stringify({ ok, error: ok ? undefined : "no such subagent (or it was stopped)" });
            }
            if (name === "agent_stop") {
                const ok = host.stop(String(args.id ?? ""));
                return JSON.stringify({ ok, error: ok ? undefined : "no such subagent" });
            }
            // spawn_agent — spawning runs tools, so disallow in read-only plan mode.
            if (planMode) { return JSON.stringify({ error: "plan mode: spawning subagents is disabled" }); }
            const background = args.background === true;
            const st = await host.spawn({
                agent: String(args.agent ?? ""),
                task: String(args.task ?? ""),
                backend: args.backend ? String(args.backend) : undefined,
                model: args.model ? String(args.model) : undefined,
                cwd: ctx.cwd,
                background,
                parentSessionId: ctx.sessionId,
                parentBackend: ctx.parentBackend,
            });
            if (st.error && st.status === "gone") { return JSON.stringify({ error: st.error }); }
            ctx.progress?.onNotify?.(`spawned ${st.agent} (${st.backend})${background ? " in background" : ""}`);
            return JSON.stringify(st);
        }
        switch (name) {
            case "memory_search": {
                try {
                    const recs = await hub.searchMemory({
                        query: String(args.query ?? ""),
                        type: args.type ? String(args.type) : undefined,
                        limit: typeof args.limit === "number" ? args.limit : undefined,
                    });
                    return JSON.stringify(recs);
                } catch (e: unknown) {
                    // Fallback to local memory if hub fails (e.g., 401 on other backends)
                    console.warn(`[Symposium] Hub searchMemory failed, using local memory: ${e instanceof Error ? e.message : String(e)}`);
                    const local = new LocalMemory();
                    const recs = await local.searchMemory({
                        query: String(args.query ?? ""),
                        type: args.type ? String(args.type) : undefined,
                        limit: typeof args.limit === "number" ? args.limit : undefined,
                    });
                    // ALERT MODEL that this is LOCAL memory, NOT shared cross-agent memories
                    const result = {
                        _notice: "SHARED MEMORY UNAVAILABLE: Using local fallback. Results are from local session storage only, not from shared cross-agent knowledge.",
                        _memory_source: "local_fallback",
                        records: recs,
                    };
                    return JSON.stringify(result);
                }
            }
            case "memory_get_observations": {
                try {
                    const ids = Array.isArray(args.ids) ? args.ids.map(String) : [];
                    return JSON.stringify(await hub.getByIds(ids));
                } catch (e: unknown) {
                    // Fallback to local memory if hub fails
                    console.warn(`[Symposium] Hub getByIds failed, using local memory: ${e instanceof Error ? e.message : String(e)}`);
                    const local = new LocalMemory();
                    const ids = Array.isArray(args.ids) ? args.ids.map(String) : [];
                    const observations = await local.getByIds(ids);
                    // ALERT MODEL that this is LOCAL memory, NOT shared cross-agent memories
                    const result = {
                        _notice: "SHARED MEMORY UNAVAILABLE: Using local fallback. Observations are from local session storage only, not from shared cross-agent knowledge.",
                        _memory_source: "local_fallback",
                        observations,
                    };
                    return JSON.stringify(result);
                }
            }
            case "memory_save": {
                // Bind task observations to the current Symposium chat session so
                // they can be listed in the Tasks panel and removed with it.
                let tags = args.tags ? String(args.tags) : "";
                const type = String(args.type ?? "note");
                if (ctx.sessionId && type.startsWith("task")) {
                    const tag = `symposium-session:${ctx.sessionId}`;
                    if (!tags.split(",").map((t) => t.trim()).includes(tag)) {
                        tags = tags ? `${tags},${tag}` : tag;
                    }
                }
                try {
                    const id = await hub.save({
                        type,
                        title: String(args.title ?? ""),
                        summary: String(args.summary ?? ""),
                        payload: args.payload ? String(args.payload) : undefined,
                        tags: tags || undefined,
                    });
                    return JSON.stringify({ id });
                } catch (e: unknown) {
                    // Fallback to local memory if hub fails
                    console.warn(`[Symposium] Hub save failed, using local memory: ${e instanceof Error ? e.message : String(e)}`);
                    const local = new LocalMemory();
                    const id = await local.save({
                        type,
                        title: String(args.title ?? ""),
                        summary: String(args.summary ?? ""),
                        payload: args.payload ? String(args.payload) : undefined,
                        tags: tags || undefined,
                    });
                    // ALERT MODEL that this was saved to LOCAL memory, NOT shared cross-agent knowledge
                    const result = {
                        id,
                        _notice: "SHARED MEMORY UNAVAILABLE: Saved to local fallback storage only. This observation is NOT available in shared cross-agent knowledge.",
                        _memory_source: "local_fallback",
                    };
                    return JSON.stringify(result);
                }
            }
            case "TaskCreate":
            case "add_task": {
                if (!ctx.sessionId) { return JSON.stringify({ error: "no current session" }); }
                if (!hub.configured()) { return JSON.stringify({ error: "memory hub not configured" }); }
                const raw = Array.isArray(args.tasks) ? args.tasks : (args.title ? [args.title] : []);
                const titles = raw.map((t) => (typeof t === "string" ? t : (t && typeof t === "object" ? (t as { title?: string }).title : ""))).map((s) => String(s ?? "").trim()).filter(Boolean);
                if (!titles.length) { return JSON.stringify({ error: "provide tasks: [\"step 1\", \"step 2\", …]" }); }
                const userRequested = args.user_requested === true;
                const creatorTag = userRequested ? "creator:user" : "creator:agent";
                const tags = `task-anchor,${sessionTag(ctx.sessionId)},${creatorTag}`;
                const ids: string[] = [];
                for (const title of titles) {
                    const id = await hub.save({ type: "task-anchor", title: title.slice(0, 80), summary: title, tags });
                    if (id) { ids.push(id); }
                }
                const reminder = userRequested
                    ? "USER-REQUESTED TASKS: When you finish, present justification and WAIT for user confirmation before calling task_complete."
                    : "AGENT TASKS: Call task_complete(id) immediately after finishing each task - don't wait.";
                return JSON.stringify({
                    ok: true,
                    created: ids.length,
                    ids,
                    user_requested: userRequested,
                    reminder,
                });
            }
            case "list_tasks": {
                if (!ctx.sessionId) { return JSON.stringify({ tasks: [] }); }
                const all = await fetchSessionTasks(hub, ctx.sessionId);
                const includeDone = args.all === true;
                const tasks = (includeDone ? all : all.filter((t) => !t.done))
                    .map((t) => {
                        const tags = String(t.tags || "").split(",").map((tag) => tag.trim());
                        const userRequested = tags.includes("creator:user");
                        return {
                            id: t.id,
                            type: t.type,
                            title: t.title,
                            summary: t.summary,
                            done: !!t.done,
                            user_requested: userRequested,
                        };
                    });
                return JSON.stringify({ tasks, pendingOnly: !includeDone });
            }
            case "TaskUpdate":
            case "task_complete": {
                const id = String(args.id ?? "");
                if (!id) { return JSON.stringify({ error: "id is required" }); }
                if (!hub.configured()) { return JSON.stringify({ error: "memory hub not configured" }); }
                // TaskUpdate uses done param, task_complete is implicit done=true
                const isDone = name === "TaskUpdate" ? (args.done !== false) : true;
                if (!isDone) {
                    return JSON.stringify({ ok: true, message: "task unchanged (done=false)" });
                }
                const ok = await markTaskDone(hub, id);
                // Silence success — empty string saves tokens; errors/JSON only on failure.
                return ok ? "" : JSON.stringify({ error: "save failed — check hub configuration" });
            }
            case "add_guardrail": {
                const text = String(args.text ?? "").trim();
                if (!text) { return JSON.stringify({ error: "text is required" }); }
                if (!ctx.sessionId) { return JSON.stringify({ error: "no current session" }); }
                try {
                    if (!hub.configured()) { throw new Error("memory hub not configured"); }
                    const id = await saveGuardrail(hub, ctx.sessionId, text);
                    // Silence success — empty string saves tokens; only the panel refresh matters.
                    return id ? "" : JSON.stringify({ error: "save failed" });
                } catch (e: unknown) {
                    // Fallback to local memory if hub fails
                    console.warn(`[Symposium] Hub saveGuardrail failed, using local memory: ${e instanceof Error ? e.message : String(e)}`);
                    const local = new LocalMemory();
                    const id = await local.save({
                        type: "guardrail",
                        title: `Guardrail for session ${ctx.sessionId}`,
                        summary: text,
                        tags: `symposium-session:${ctx.sessionId},guardrail`,
                    });
                    // ALERT MODEL that this was saved to LOCAL memory, NOT shared cross-agent knowledge
                    const result = {
                        id: id.id,
                        _notice: "SHARED MEMORY UNAVAILABLE: Guardrail saved to local fallback storage only. It will persist in this session but is NOT available in shared cross-agent knowledge.",
                        _memory_source: "local_fallback",
                    };
                    return JSON.stringify(result);
                }
            }
            case "clear_guardrails": {
                if (!ctx.sessionId) { return JSON.stringify({ error: "no current session" }); }
                try {
                    if (!hub.configured()) { throw new Error("memory hub not configured"); }
                    const removed = await clearSessionGuardrails(hub, ctx.sessionId);
                    // Silence success — empty string saves tokens.
                    return removed >= 0 ? "" : JSON.stringify({ error: "clear failed" });
                } catch (e: unknown) {
                    // Fallback to local memory if hub fails
                    console.warn(`[Symposium] Hub clearSessionGuardrails failed, using local memory: ${e instanceof Error ? e.message : String(e)}`);
                    const local = new LocalMemory();
                    const allObs = await local.searchMemory({
                        query: "",
                        type: "guardrail",
                        limit: 100,
                    });
                    // Filter guardrails for this session
                    const sessionGuardrails = allObs.filter((obs) =>
                        obs.tags?.includes(`symposium-session:${ctx.sessionId}`)
                    );
                    // Soft-delete each guardrail
                    for (const obs of sessionGuardrails) {
                        if (obs.id) {
                            await local.save({
                                type: obs.type,
                                title: obs.title,
                                summary: obs.summary,
                                tags: obs.tags,
                                expiresAtUtc: new Date(Date.now() - 86400000).toISOString(), // 24 hours ago = soft-delete
                                id: obs.id,
                            });
                        }
                    }
                    // ALERT MODEL that this cleared from LOCAL memory, NOT shared cross-agent knowledge
                    const result = {
                        removed: sessionGuardrails.length,
                        _notice: `SHARED MEMORY UNAVAILABLE: Cleared ${sessionGuardrails.length} guardrail(s) from local fallback storage only. Shared cross-agent knowledge was not affected.`,
                        _memory_source: "local_fallback",
                    };
                    return JSON.stringify(result);
                }
            }
            case "web_search": {
                const r = await hub.webSearch(String(args.query ?? ""), typeof args.limit === "number" ? args.limit : 8);
                return JSON.stringify(r).slice(0, 12000);
            }
            default:
                return JSON.stringify({ error: `unknown tool ${name}` });
        }
    } catch (err) {
        return JSON.stringify({ error: String(err) });
    }
}
