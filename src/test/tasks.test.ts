import { test } from "node:test";
import assert from "node:assert/strict";
import * as vscode from "vscode";
import { runTaskTool } from "../adapters/aiTools/taskRun";
import { HubClient, Observation } from "../sync/hubClient";
import {
    fetchSessionTasks,
    fetchPendingWorkItems,
    fetchSessionCheckpoints,
    fetchLatestCheckpoint,
    rememberTaskCreated,
    rememberTaskDone,
    setTaskDone,
} from "../sync/tasks";

test("pending tasks do not expire locally while the hub index is stale", async () => {
    const originalNow = Date.now;
    let now = 1_000;
    Date.now = () => now;
    try {
        const sessionId = "task-cache-long-plan";
        rememberTaskCreated(sessionId, "task-a", "First long-running step");
        rememberTaskCreated(sessionId, "task-b", "Second long-running step");
        now += 24 * 60 * 60 * 1_000;

        const hub = {
            configured: () => true,
            searchMemory: () => Promise.resolve([]),
        } as unknown as HubClient;
        rememberTaskDone(sessionId, "task-a");
        const pending = await fetchSessionTasks(hub, sessionId);

        assert.deepEqual(
            pending.map((task) => task.id),
            ["task-b"],
        );
    } finally {
        Date.now = originalNow;
    }
});

test("indexed tasks replace the local anti-lag copy", async () => {
    const sessionId = "task-cache-indexed";
    rememberTaskCreated(sessionId, "task-indexed", "Indexed step");
    const hub = {
        configured: () => true,
        searchMemory: () =>
            Promise.resolve([
                {
                    id: "task-indexed",
                    type: "task-anchor",
                    sessionId,
                    title: "Indexed step",
                    summary: "Indexed step",
                    tags: "task-anchor",
                    createdAtUtc: "2026-07-21T00:00:00Z",
                },
            ]),
    } as unknown as HubClient;

    const tasks = await fetchSessionTasks(hub, sessionId);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].id, "task-indexed");
});

// --- Regressão entrega 0A: task-checkpoint (estado observado) nunca é work item ---
// Um checkpoint descreve um fato/decisão/resultado ("corrigido e implantado"),
// não trabalho a fazer. Ele não pode aparecer como pending nem virar a tarefa
// CURRENT — esse era o defeito que fazia o agente retomar trabalho concluído.

/** Hub mock que retorna um conjunto fixo de records para uma sessão. */
function hubReturning(records: Array<Record<string, unknown>>): HubClient {
    return {
        configured: () => true,
        searchMemory: () => Promise.resolve(records),
    } as unknown as HubClient;
}

test("fetchPendingWorkItems excludes task-checkpoint (only task-anchor counts as work)", async () => {
    const sessionId = "sep-checkpoint-from-work";
    const hub = hubReturning([
        {
            id: "cp-1",
            type: "task-checkpoint",
            sessionId,
            title: "fix concluído e implantado",
            summary: "deploy done",
            tags: "",
            createdAtUtc: "2026-07-27T00:00:00Z",
        },
        {
            id: "task-1",
            type: "task-anchor",
            sessionId,
            title: "implementar rescan",
            summary: "rescan",
            tags: "",
            createdAtUtc: "2026-07-27T01:00:00Z",
        },
    ]);

    const pending = await fetchPendingWorkItems(hub, sessionId);
    assert.deepEqual(
        pending.map((t) => t.id),
        ["task-1"],
    );
});

test("fetchSessionCheckpoints returns only task-checkpoint records", async () => {
    const sessionId = "sep-checkpoints-read";
    const hub = hubReturning([
        {
            id: "task-1",
            type: "task-anchor",
            sessionId,
            title: "work",
            summary: "work",
            tags: "",
            createdAtUtc: "2026-07-27T01:00:00Z",
        },
        {
            id: "cp-1",
            type: "task-checkpoint",
            sessionId,
            title: "estado atual",
            summary: "feito",
            tags: "",
            createdAtUtc: "2026-07-27T00:00:00Z",
        },
        {
            id: "cp-2",
            type: "task-checkpoint",
            sessionId,
            title: "decisão",
            summary: "usar X",
            tags: "",
            createdAtUtc: "2026-07-27T02:00:00Z",
        },
    ]);

    const checkpoints = await fetchSessionCheckpoints(hub, sessionId);
    assert.deepEqual(
        checkpoints.map((t) => t.id),
        ["cp-2", "cp-1"],
    ); // newest first
});

test("fetchSessionTasks still returns everything (panel/list_tasks intact)", async () => {
    const sessionId = "full-read-intact";
    const hub = hubReturning([
        {
            id: "task-1",
            type: "task-anchor",
            sessionId,
            title: "work",
            summary: "work",
            tags: "",
            createdAtUtc: "2026-07-27T01:00:00Z",
        },
        {
            id: "cp-1",
            type: "task-checkpoint",
            sessionId,
            title: "feito",
            summary: "feito",
            tags: "",
            createdAtUtc: "2026-07-27T00:00:00Z",
        },
    ]);

    const all = await fetchSessionTasks(hub, sessionId);
    assert.deepEqual(all.map((t) => t.id).sort(), ["cp-1", "task-1"]);
});

test("fetchLatestCheckpoint does NOT fall back to a pending task-anchor", async () => {
    // Sem nenhum task-checkpoint, o resume hook não deve promover uma work item
    // pendente a "checkpoint de resume" — isso confundiria "o que fazer" com
    // "onde as coisas estão".
    const sessionId = "no-checkpoint-no-fallback";
    const hub = hubReturning([
        {
            id: "task-1",
            type: "task-anchor",
            sessionId,
            title: "work pendente",
            summary: "work",
            tags: "",
            createdAtUtc: "2026-07-27T01:00:00Z",
        },
    ]);

    const cp = await fetchLatestCheckpoint(hub, sessionId);
    assert.equal(cp, undefined);
});

test("fetchLatestCheckpoint returns the newest task-checkpoint (resume anchor)", async () => {
    const sessionId = "latest-checkpoint-resume";
    const hub = hubReturning([
        {
            id: "cp-1",
            type: "task-checkpoint",
            sessionId,
            title: "mais antigo",
            summary: "old",
            tags: "",
            createdAtUtc: "2026-07-27T00:00:00Z",
        },
        {
            id: "cp-2",
            type: "task-checkpoint",
            sessionId,
            title: "mais novo",
            summary: "new",
            tags: "",
            createdAtUtc: "2026-07-27T02:00:00Z",
        },
    ]);

    const cp = await fetchLatestCheckpoint(hub, sessionId);
    assert.equal(cp?.id, "cp-2");
});

test("a done task-anchor is not a pending work item", async () => {
    const sessionId = "done-work-item-excluded";
    const hub = hubReturning([
        {
            id: "task-1",
            type: "task-anchor",
            sessionId,
            title: "done work",
            summary: "done",
            tags: "status:done",
            createdAtUtc: "2026-07-27T01:00:00Z",
        },
        {
            id: "task-2",
            type: "task-anchor",
            sessionId,
            title: "open work",
            summary: "open",
            tags: "",
            createdAtUtc: "2026-07-27T02:00:00Z",
        },
    ]);

    const pending = await fetchPendingWorkItems(hub, sessionId);
    assert.deepEqual(
        pending.map((t) => t.id),
        ["task-2"],
    );
});

test("task aliases complete internal observations with the same session header as creation", async (t) => {
    const sessionId = "internal-task-session";
    const observations = new Map<string, Observation>();
    t.mock.method(vscode.workspace, "getConfiguration", () => ({
        get: (key: string, fallback: unknown) =>
            key === "url" ? "https://hub.example.test" : key === "token" ? "same-token" : fallback,
    }));
    t.mock.method(globalThis, "fetch", (url: string, init: RequestInit) => {
        const headers = new Headers(init.headers);
        assert.equal(headers.get("Authorization"), "Bearer same-token");
        const trustedSession = headers.get("X-Symposium-Session-Id");
        const body = JSON.parse(String(init.body));
        switch (new URL(url).pathname) {
            case "/api/memory/save": {
                const existing = observations.get(body.id);
                if (trustedSession !== (existing?.sessionId ?? body.sessionId) || !trustedSession) {
                    return new Response(null, { status: 403 });
                }
                const id = body.id ?? `task-${observations.size + 1}`;
                observations.set(id, { ...existing, ...body, id });
                return Response.json({ success: true, data: { id } });
            }
            case "/api/memory/observations":
                return Response.json(
                    Array.from(observations.values()).filter(
                        (obs) => obs.sessionId === trustedSession && body.ids.includes(obs.id),
                    ),
                );
            case "/api/memory/search":
                return Response.json(Array.from(observations.values()));
            default:
                assert.fail(`Unexpected hub request: ${url}`);
        }
    });
    const hub = new HubClient();
    const ctx = { hub, cwd: "/workspace", sessionId };
    const { ids } = JSON.parse(
        (await runTaskTool("add_task", { tasks: ["First task", "Second task"] }, ctx))!,
    );

    for (const [index, name] of ["task_complete", "TaskUpdate"].entries()) {
        const id = ids[index];
        const result = JSON.parse((await runTaskTool(name, { id, summary: "Verified" }, ctx))!);
        assert.equal(result.ok, true, result.error);
        assert.deepEqual(observations.get(id), {
            id,
            sessionId,
            privacyLevel: "internal",
            type: "task-anchor",
            title: index === 0 ? "First task" : "Second task",
            summary: `${index === 0 ? "First task" : "Second task"}\n\nCompleted: Verified`,
            tags: "task-anchor,creator:agent,status:done",
        });
    }
    const first = observations.get(ids[0])!;
    assert.equal(first.summary, "First task\n\nCompleted: Verified");
    first.expiresAtUtc = "2099-01-01T00:00:00Z";
    assert.equal(await setTaskDone(hub, sessionId, ids[0], false), true);
    assert.equal(observations.get(ids[0])?.tags, "task-anchor,creator:agent");
    assert.equal(observations.get(ids[0])?.expiresAtUtc, first.expiresAtUtc);

    const wrongSession = { ...ctx, sessionId: "other-session" };
    const otherResult = JSON.parse(
        (await runTaskTool("task_complete", { id: ids[0] }, wrongSession))!,
    );
    assert.match(otherResult.error, /not found/);
});
