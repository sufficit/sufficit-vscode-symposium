import { SurfaceDialoguesDeps } from "./surfaceDialoguesTypes";
import { completedTaskIds } from "../sync/taskUi";

/**
 * The controller observer callback for a live dialogue: filters the raw
 * edited-files set against git status, captures a freshly-assigned session id
 * as "last active", repaints guardrails/tasks the moment a session-mutating
 * tool finishes, and re-mirrors the working tree at turn-end. Extracted out of
 * `SurfaceDialogues.openDialogue` (check:size) — same closure semantics via an
 * explicit `d`/`backend` pair instead of captured `this`.
 */
/** Applies surface-only effects without forwarding chat render output. */
export function handleControllerSideEffect(
    d: SurfaceDialoguesDeps,
    backend: string,
    message: unknown,
): boolean {
    // The controller emits the RAW edited-files set; the surface filters
    // it against live git status (so staged files drop, unstaging them
    // brings them back) before showing it.
    const msg = message as Record<string, unknown> | null;
    if (msg?.type === "changed-files" && "items" in msg && Array.isArray(msg.items)) {
        void d.changedFiles.refresh(msg.items);
        return true;
    }
    // Capture a freshly-assigned session id so a brand-new dialogue
    // also becomes the restorable "last active" one.
    const ev = msg?.event as
        | { kind?: string; sessionId?: string; toolName?: string; result?: string }
        | undefined;
    if (ev?.kind === "session" && ev.sessionId) {
        const sessionId = d.getController()?.sessionKey ?? ev.sessionId;
        d.deps.lastActive.set({ backend, sessionId });
        d.deps.store.setLineage(sessionId, d.getController()?.lineageId);
        d.onSessionCreated?.(sessionId);
    }
    // Repaint the affected panel the moment a session-mutating tool finishes,
    // so an agent-added guardrail / task shows immediately instead of only at
    // turn-end. We parse the tool's own result to read the freshly-created
    // record by its id (instant, deterministic — never waits for the hub's
    // async search index), then let the search-based refresh reconcile.
    if (ev?.kind === "tool-end" && typeof ev.toolName === "string") {
        const n = ev.toolName;
        // Tools return "" on success to save tokens; a JSON body signals a
        // result we can mine for ids (add_task returns ids[]; add_guardrail
        // returns "" on hub success or {id,_memory_source} on local fallback).
        let parsed: {
            ids?: string[];
            completed?: string[];
            id?: string;
            _memory_source?: string;
        } | null = null;
        if (typeof ev.result === "string" && ev.result.trim().startsWith("{")) {
            try {
                parsed = JSON.parse(ev.result);
            } catch {
                parsed = null;
            }
        }
        if (n === "add_guardrail") {
            if (parsed?.id) {
                // Read-by-id: the guardrail shows immediately even before the
                // hub search index settles. Local fallback reads from disk.
                const src = parsed._memory_source === "local_fallback" ? "local" : "hub";
                void d.sync.bumpGuardrailById(String(parsed.id), src);
            }
            // Reconcile via search with backoff (covers clear_guardrails and
            // any high-latency hub).
            const repaint = () =>
                void d
                    .getController()
                    ?.reloadGuardrails()
                    .then(() => d.sync.refreshGuardrails());
            void repaint();
            for (const delay of [400, 1000, 2000]) {
                setTimeout(repaint, delay);
            }
        } else if (n === "clear_guardrails") {
            d.sync.clearGuardrails();
            const repaint = () =>
                void d
                    .getController()
                    ?.reloadGuardrails()
                    .then(() => d.sync.refreshGuardrails());
            void repaint();
            for (const delay of [400, 1000, 2000]) {
                setTimeout(repaint, delay);
            }
        } else if (n === "add_task" || n === "TaskCreate") {
            const ids = Array.isArray(parsed?.ids)
                ? parsed.ids.filter((x): x is string => typeof x === "string")
                : [];
            if (ids.length) {
                void d.sync.bumpTasksByIds(ids);
            } else {
                void d.sync.refreshTasks();
            }
            setTimeout(() => void d.sync.refreshTasks(), 700);
        } else if (n === "task_complete" || n === "TaskUpdate") {
            const completed = completedTaskIds(parsed);
            if (completed.length) {
                d.sync.setTasksDoneByIds(completed, true);
            } else {
                void d.sync.refreshTasks();
            }
            setTimeout(() => void d.sync.refreshTasks(), 700);
        } else if (n === "memory_save") {
            void d.sync.refreshTasks();
            setTimeout(() => void d.sync.refreshTasks(), 700);
        }
    }
    // Refresh the Tasks panel when a turn ends: the agent may have saved
    // task-checkpoints mid-turn (bound to this session), which the panel
    // otherwise wouldn't pick up until reopen/manual refresh.
    if (ev?.kind === "turn-end") {
        void d.sync.refreshTasks();
        // The agent may have added a guardrail mid-turn (add_guardrail tool):
        // reload the controller's injection cache and repaint the panel.
        void d
            .getController()
            ?.reloadGuardrails()
            .then(() => d.sync.refreshGuardrails());
        // Re-mirror the working tree from git: a turn may have edited files
        // via shell/sed (no tool event, no index change) that the live
        // changed-files signal and the .git/index watcher both miss.
        d.changedFiles.refreshNow();
    }
    return false;
}
