import { fetchSessionTasks, fetchPendingWorkItems, markTaskDone, rememberTaskCreated, rememberTaskDone, rememberTaskBatch, priorInBatch } from "../../sync/tasks";
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
            // spawn_agent — allowed even under a read-only/plan-mode guardrail; the
            // subagent inherits the parent's permission (a read-only parent yields a
            // read-only subagent) so delegation works without escalating access.
            const background = args.background === true;
            const st = await host.spawn({
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
                const type = String(args.type ?? "note");
                const tags = args.tags ? String(args.tags) : "";
                // Validate task types against the two allowed values so a confused
                // agent emitting e.g. type:"task-note" doesn't pollute the panel
                // with items that are neither work nor checkpoint and can never be
                // cleared by task_complete (defect 2.2). Unknown task-* types are
                // normalized to "note" (session-unscoped, won't appear in Tasks).
                const ALLOWED_TASK_TYPES = new Set(["task-anchor", "task-checkpoint"]);
                const effectiveType = type.startsWith("task") && !ALLOWED_TASK_TYPES.has(type) ? "note" : type;
                // Session-bound types (tasks) are scoped via the native sessionId
                // field + privacy level internal, so they never leak outside the
                // session; no need for a symposium-session: tag.
                const sessionScoped = ctx.sessionId && effectiveType.startsWith("task");
                try {
                    const id = await hub.save({
                        type: effectiveType,
                        title: String(args.title ?? ""),
                        summary: String(args.summary ?? ""),
                        payload: args.payload ? String(args.payload) : undefined,
                        tags: tags || undefined,
                        sessionId: sessionScoped ? ctx.sessionId : undefined,
                        privacyLevel: sessionScoped ? "internal" : undefined,
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
                const tags = `task-anchor,${creatorTag}`;
                const ids: string[] = [];
                for (const title of titles) {
                    const id = await hub.save({ type: "task-anchor", title: title.slice(0, 80), summary: title, tags, sessionId: ctx.sessionId, privacyLevel: "internal" });
                    if (id) {
                        ids.push(id);
                        // The hub's search index can lag behind this save — remember it
                        // locally so task_complete's "remaining" check (a search read)
                        // can't miss it and wrongly report allTasksComplete too early.
                        rememberTaskCreated(ctx.sessionId, id, title);
                    }
                }
                // The array is documented as "in order" — one add_task call is a
                // numbered plan, so task_complete cascades earlier ids in THIS
                // batch when a later one finishes (see priorInBatch).
                rememberTaskBatch(ctx.sessionId, ids);
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
                if (!id) {
                    return JSON.stringify({
                        error: "id is required — this must be the exact task id (a UUID), not a title or summary. " +
                            "Use the id from the '→ CURRENT (id=...)' line in your task reminder, or call list_tasks to get it.",
                    });
                }
                if (!hub.configured()) { return JSON.stringify({ error: "memory hub not configured" }); }
                // TaskUpdate uses done param, task_complete is implicit done=true
                const isDone = name === "TaskUpdate" ? (args.done !== false) : true;
                if (!isDone) {
                    return JSON.stringify({ ok: true, message: "task unchanged (done=false)" });
                }
                const completionSummary = typeof args.summary === "string" ? args.summary : undefined;
                const ok = await markTaskDone(hub, id, completionSummary);
                if (!ok) { return JSON.stringify({ error: "save failed — check hub configuration" }); }
                if (ctx.sessionId) { rememberTaskDone(ctx.sessionId, id); }
                // Cascade: this id's add_task batch is a numbered plan ("in order"),
                // so finishing a later step implies the earlier ones in that SAME
                // batch are done too — covers the common slip where the agent
                // narrates through several steps and only calls task_complete on
                // the last one. markTaskDone is idempotent, safe to re-call on ones
                // already done.
                const cascaded: string[] = [];
                const priorIds = ctx.sessionId ? priorInBatch(ctx.sessionId, id) : [];
                if (priorIds.length) {
                    // Never auto-complete a user-requested task without the user's
                    // own confirmation — the cascade only covers agent-created ones.
                    const priorObs = await hub.getByIds(priorIds).catch(() => []);
                    const userRequestedIds = new Set(
                        (priorObs as Array<{ id: unknown; tags?: string | string[] }>)
                            .filter((o) => (Array.isArray(o.tags) ? o.tags : String(o.tags ?? "").split(",")).map((t) => String(t).trim()).includes("creator:user"))
                            .map((o) => String(o.id)),
                    );
                    for (const priorId of priorIds) {
                        if (userRequestedIds.has(priorId)) { continue; }
                        if (await markTaskDone(hub, priorId, completionSummary)) {
                            rememberTaskDone(ctx.sessionId as string, priorId);
                            cascaded.push(priorId);
                        }
                    }
                }
                // Return the remaining pending tasks (current + up-next) as the
                // success response instead of a silent "" — the agent gets its
                // next step handed back immediately, with no separate list_tasks
                // round-trip, so it can't lose track of the plan mid-execution.
                if (!ctx.sessionId) { return JSON.stringify({ ok: true }); }
                const completed = [id, ...cascaded];
                const completedSet = new Set(completed);
                // Next-step hand-back: pending WORK ITEMS only (task-anchor, not
                // done). A task-checkpoint (observed state) must never be handed
                // back as the next CURRENT step — completing work and observing
                // state are different things. Excludes the just-completed ids.
                const remaining = (await fetchPendingWorkItems(hub, ctx.sessionId)).filter((t) => !completedSet.has(t.id));
                const cascadeNote = cascaded.length
                    ? `Also auto-completed ${cascaded.length} earlier step(s) from the same numbered plan (they precede this one in the same add_task call).`
                    : undefined;
                if (!remaining.length) {
                    return JSON.stringify({ ok: true, completed, pending: [], message: "all tasks complete", allTasksComplete: true, cascaded, note: cascadeNote });
                }
                const [current, ...rest] = remaining;
                return JSON.stringify({
                    ok: true,
                    completed,
                    current: { id: current.id, title: current.title },
                    pending: rest.map((t) => ({ id: t.id, title: t.title })),
                    cascaded,
                    note: cascadeNote,
                });
            }
            case "add_guardrail": {
                const text = String(args.text ?? "").trim();
                if (!text) { return JSON.stringify({ error: "text is required" }); }
                if (!ctx.sessionId) { return JSON.stringify({ error: "no current session" }); }
                try {
                    if (!hub.configured()) { throw new Error("memory hub not configured"); }
                    const id = await saveGuardrail(hub, ctx.sessionId, text);
                    // Return the id (not silent "") so the UI can read it back
                    // by id instantly instead of racing the hub's eventually
                    // consistent search index (which can lag past the retry
                    // window and leave the panel looking like it never landed).
                    return id ? JSON.stringify({ id }) : JSON.stringify({ error: "save failed" });
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
