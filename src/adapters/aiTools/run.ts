import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { readSession, dumpToText } from "../../sessionReader";
import { mimeTypeFor } from "../parse";
import { fetchSessionTasks, markTaskDone, sessionTag } from "../../sync/tasks";
import { saveGuardrail, clearSessionGuardrails } from "../../sync/guardrails";
import { workspaceKey, resourceContentPath, ensureScaffold, readWorkspaceBootstrap } from "../../config/root";
import { ToolContext, getLiveTranscriptReader } from "./types";
import { canUseRtk, normalizeTerminalId, resolvePath, runShell, runShellInTerminal } from "./shell";
import { LocalMemory } from "./localMemory";

/** Strips HTML to readable text (drops script/style, tags → spaces). */
function htmlToText(html: string): string {
    return html
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<!--[\s\S]*?-->/g, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .replace(/[ \t\f\r]+/g, " ")
        .replace(/\n\s*\n\s*\n+/g, "\n\n")
        .trim();
}

/** Executes one tool call. Returns a JSON string for the model. */
export async function runAiTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const hub = ctx.hub;
    const planMode = ctx.permission === "plan";
    try {
        // ---- web navigation ----
        if (name === "fetch_url") {
            const url = String(args.url ?? "").trim();
            if (!/^https?:\/\//i.test(url)) { return JSON.stringify({ error: "url must start with http(s)://" }); }
            const max = Number(args.max_chars) || 30000;
            const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (Symposium VS Code agent)" } });
            const ct = res.headers.get("content-type") || "";
            const raw = await res.text();
            const body = /html/i.test(ct) ? htmlToText(raw) : raw;
            return JSON.stringify({ url, status: res.status, content_type: ct, content: body.slice(0, max), truncated: body.length > max });
        }
        if (name === "open_url") {
            const url = String(args.url ?? "").trim();
            if (!/^https?:\/\//i.test(url)) { return JSON.stringify({ error: "url must start with http(s)://" }); }
            await vscode.commands.executeCommand("simpleBrowser.show", url);
            return JSON.stringify({ opened: url });
        }
        // ---- session memory (read-only, allowed in plan mode) ----
        if (name === "read_session") {
            const id = String(args.id ?? "").trim() || ctx.sessionId;
            if (!id) { return JSON.stringify({ error: "no session id (none provided and no current session)" }); }
            const tail = typeof args.tail === "number" ? args.tail : undefined;
            const maxChars = typeof args.max_chars === "number" ? args.max_chars : undefined;
            // Disk (ledger) is the lossless, complete history. A RESUMED session's
            // live controller only holds post-resume messages, so it must NOT shadow
            // the ledger. Pick whichever source has MORE messages: live wins only
            // when it has unflushed messages the ledger doesn't yet have; disk wins
            // for resumed sessions where the ledger is complete. Either way we never
            // error — a running session always has at least its current message, and
            // when nothing is found we return an empty-but-valid dump, not an error
            // (an error would make the agent believe it has no context).
            const disk = readSession(id);
            const live = getLiveTranscriptReader()?.read(id);
            const liveCount = live ? live.messages.length : 0;
            if (live && liveCount > disk.count) {
                const dump = { id, source: "live" as const, backend: live.backend ?? disk.backend, title: live.title ?? disk.title, count: liveCount, messages: live.messages };
                return dumpToText(dump, { tail, maxChars });
            }
            if (disk.source !== "none") {
                return dumpToText(disk, { tail, maxChars });
            }
            // Nothing on disk: fall back to live even if it ties at 0, then to an
            // empty dump so the caller always gets a well-formed transcript.
            const dump = live
                ? { id, source: "live" as const, backend: live.backend, title: live.title, count: liveCount, messages: live.messages }
                : { id, source: "none" as const, count: 0, messages: [] };
            return dumpToText(dump, { tail, maxChars });
        }
        // ---- per-workspace session bootstrap (a local config file, NOT memory) ----
        if (name === "get_workspace_bootstrap") {
            const bs = readWorkspaceBootstrap(ctx.cwd);
            return JSON.stringify(bs
                ? { key: bs.name, path: bs.path, text: bs.text }
                : { key: workspaceKey(ctx.cwd), text: "", note: "no bootstrap set for this workspace" });
        }
        if (name === "set_workspace_bootstrap") {
            const text = String(args.text ?? "").trim();
            if (!text) { return JSON.stringify({ error: "text is required" }); }
            ensureScaffold();
            const key = workspaceKey(ctx.cwd);
            const file = resourceContentPath("bootstrap", key);
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, text.endsWith("\n") ? text : text + "\n", "utf8");
            return JSON.stringify({ ok: true, key, path: file, bytes: Buffer.byteLength(text) });
        }
        // ---- local workspace tools (shell / filesystem) ----
        if (name === "shell") {
            if (planMode) { return JSON.stringify({ error: "plan mode: command execution is disabled" }); }
            const command = String(args.command ?? "").trim();
            if (!command) { return JSON.stringify({ error: "empty command" }); }
            const cwd = args.cwd ? resolvePath(ctx.cwd, String(args.cwd)) : ctx.cwd;
            // Timeout: default 30s. 0 (or negative) means UNLIMITED — the model
            // must opt into that explicitly for long-running services. A bounded
            // value is clamped to [1s, 1h].
            const rawTimeout = args.timeout_ms === undefined ? 30000 : Number(args.timeout_ms);
            const unlimited = !(rawTimeout > 0);
            const timeout = unlimited ? Number.MAX_SAFE_INTEGER : Math.min(Math.max(rawTimeout, 1000), 3600000);
            const notify = args.notify === true;
            const mode = ctx.shellExecution ?? "silent";
            const terminalId = mode === "terminal" ? normalizeTerminalId(args.terminal_id) : undefined;
            const shouldUseRtk = mode === "silent" && await canUseRtk(command, cwd);
            const runCommand = shouldUseRtk ? `rtk ${command}` : command;
            const terminalRun = mode === "terminal"
                ? await runShellInTerminal(runCommand, cwd, timeout, ctx.progress, terminalId, ctx.abortSignal)
                : undefined;
            const { stdout, code } = terminalRun ?? await runShell(runCommand, cwd, timeout, mode === "inline" ? ctx.progress : undefined, ctx.abortSignal);
            // When the model flags the result as relevant, push it through the
            // progress sink as a steer-style notification so the chat surfaces it
            // even if the model wouldn't otherwise narrate the outcome.
            if (notify) {
                const head = stdout.split("\n").slice(0, 6).join("\n");
                ctx.progress?.onNotify?.(`shell exit ${code}${head ? `\n${head}` : ""}`);
            }
            return JSON.stringify({
                exit_code: code,
                output: stdout,
                display: mode,
                timed_out: code === 124,
                unlimited,
                terminal_id: terminalRun?.terminal_id,
                reused_terminal: terminalRun?.reused ?? false
            });
        }
        if (name === "read_file") {
            const p = resolvePath(ctx.cwd, String(args.path ?? ""));
            const buf = fs.readFileSync(p);
            const mime = mimeTypeFor(p);
            const isImage = !!mime && mime.startsWith("image/");
            // Binary detection: a NUL byte in the first chunk means it isn't text.
            const isBinary = isImage || buf.subarray(0, 4096).includes(0);
            if (isBinary) {
                // Images: return a base64 data URI (capped) instead of UTF-8
                // garbage, so a vision-capable model/preset can interpret it.
                const cap = Number(args.max_bytes) || 1_500_000;
                if (isImage && buf.length <= cap) {
                    return JSON.stringify({
                        path: p, mime, bytes: buf.length, image: true,
                        data_uri: `data:${mime};base64,${buf.toString("base64")}`,
                        note: "Binary image returned as a base64 data URI — it cannot be read as text. A vision-capable model/preset is needed to interpret it; otherwise ask the user to describe it.",
                    });
                }
                return JSON.stringify({
                    path: p, mime: mime ?? "application/octet-stream", bytes: buf.length, binary: true,
                    note: "Binary file — not shown as text" + (isImage ? " (image exceeds the inline cap; raise max_bytes to return base64)" : "") + ".",
                });
            }
            const max = Number(args.max_bytes) || 100000;
            const data = buf.toString("utf8");
            return JSON.stringify({ path: p, content: data.slice(0, max), truncated: data.length > max });
        }
        if (name === "write_file") {
            if (planMode) { return JSON.stringify({ error: "plan mode: writing files is disabled" }); }
            const p = resolvePath(ctx.cwd, String(args.path ?? ""));
            fs.mkdirSync(path.dirname(p), { recursive: true });
            fs.writeFileSync(p, String(args.content ?? ""), "utf8");
            return JSON.stringify({ path: p, bytes: Buffer.byteLength(String(args.content ?? "")) });
        }
        if (name === "edit_file") {
            if (planMode) { return JSON.stringify({ error: "plan mode: editing files is disabled" }); }
            const p = resolvePath(ctx.cwd, String(args.path ?? ""));
            const oldStr = String(args.old_string ?? "");
            const newStr = String(args.new_string ?? "");
            const replaceAll = args.replace_all === true;
            if (!oldStr) { return JSON.stringify({ error: "old_string is required and must be non-empty" }); }
            let content: string;
            try { content = fs.readFileSync(p, "utf8"); }
            catch { return JSON.stringify({ error: `file not found: ${p}` }); }
            const occurrences = content.split(oldStr).length - 1;
            if (occurrences === 0) { return JSON.stringify({ error: "old_string not found in the file (it must match exactly, including whitespace)" }); }
            if (occurrences > 1 && !replaceAll) {
                return JSON.stringify({ error: `old_string is not unique (${occurrences} matches); add surrounding context or set replace_all: true` });
            }
            const updated = replaceAll ? content.split(oldStr).join(newStr) : content.replace(oldStr, newStr);
            fs.writeFileSync(p, updated, "utf8");
            return JSON.stringify({ path: p, replaced: replaceAll ? occurrences : 1 });
        }
        if (name === "list_dir") {
            const p = args.path ? resolvePath(ctx.cwd, String(args.path)) : ctx.cwd;
            const entries = fs.readdirSync(p, { withFileTypes: true }).map((e) => ({ name: e.name, dir: e.isDirectory() }));
            return JSON.stringify({ path: p, entries });
        }
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
