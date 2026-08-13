// Unit tests for the per-session guardrails system (sessionId-scoped).
//
// Covers fetchSessionGuardrails (type + sessionId filtering, ordering) and
// reloadGuardrails (the cache used by the outbound-prompt injection), plus the
// save payload (sessionId + privacyLevel "internal"). A stub HubClient stands in
// for the memory hub — these run pure, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    fetchSessionGuardrails,
    saveGuardrail,
    clearSessionGuardrails,
    removeGuardrail,
} from "../sync/guardrails";
import { reloadGuardrails } from "../application/controllerHubState";
import type { HubStateContext } from "../application/controllerHubState";
import { buildTurnTools } from "../adapters/openai/turnTools";
import { classifyTool } from "../adapters/aiTools/permissionTiers";
import { prepareDispatch } from "../application/controllerDispatchPrep";

/** Minimal hub stub: records saves (with sessionId/privacyLevel) and serves them back. */
function hubStub(opts: { records?: any[]; configured?: boolean; searchThrows?: boolean } = {}) {
    const store: any[] = opts.records ? [...opts.records] : [];
    const filter = (rows: any[], p: { sessionId?: string }) =>
        p.sessionId ? rows.filter((r) => (r.sessionId ?? "") === p.sessionId) : rows;
    return {
        configured: () => opts.configured !== false,
        searchMemory(p: {
            query?: string;
            type?: string;
            limit?: number;
            sessionId?: string;
        }): Promise<any[]> {
            if (opts.searchThrows) {
                return Promise.reject(new Error("hub down"));
            }
            return Promise.resolve(filter(store.slice(0, p.limit ?? store.length), p));
        },
        getByIds(ids: string[]): Promise<any[]> {
            return Promise.resolve(store.filter((r) => ids.includes(String(r.id))));
        },
        save(obs: any): Promise<string> {
            if (obs.id) {
                const i = store.findIndex((r) => String(r.id) === String(obs.id));
                if (i >= 0) {
                    store[i] = { ...store[i], ...obs };
                    return Promise.resolve(String(store[i].id));
                }
            }
            const id = "g" + (store.length + 1) + "-" + Date.now();
            store.push({ id, createdAtUtc: new Date().toISOString(), ...obs });
            return Promise.resolve(id);
        },
    } as any;
}

test("fetchSessionGuardrails: returns only this session's guardrails, oldest first", async () => {
    const sid = "sess-A";
    const hub = hubStub({
        records: [
            {
                id: "1",
                type: "guardrail",
                sessionId: "sess-A",
                summary: "first",
                createdAtUtc: "2026-01-03T10:00:00Z",
            },
            {
                id: "2",
                type: "guardrail",
                sessionId: "sess-B",
                summary: "other session",
                createdAtUtc: "2026-01-03T09:00:00Z",
            },
            {
                id: "3",
                type: "task-checkpoint",
                sessionId: "sess-A",
                summary: "a task",
                createdAtUtc: "2026-01-03T11:00:00Z",
            },
            {
                id: "4",
                type: "guardrail",
                sessionId: "sess-A",
                summary: "second",
                createdAtUtc: "2026-01-03T12:00:00Z",
            },
        ],
    });
    const items = await fetchSessionGuardrails(hub, sid);
    assert.equal(items.length, 2);
    assert.deepEqual(
        items.map((i) => i.text),
        ["first", "second"],
        "ordered oldest-first, only this session's guardrails",
    );
});

test("fetchSessionGuardrails: empty when hub not configured or no session", async () => {
    assert.deepEqual(await fetchSessionGuardrails(hubStub({ configured: false }), "sess-A"), []);
    assert.deepEqual(await fetchSessionGuardrails(hubStub(), ""), []);
});

test("fetchSessionGuardrails: ignores expired and empty guardrails", async () => {
    const hub = hubStub({
        records: [
            {
                id: "expired",
                type: "guardrail",
                sessionId: "sess-filter",
                summary: "old",
                expiresAtUtc: "2020-01-01T00:00:00Z",
            },
            {
                id: "empty",
                type: "guardrail",
                sessionId: "sess-filter",
                summary: "",
            },
            {
                id: "live",
                type: "guardrail",
                sessionId: "sess-filter",
                summary: "keep this",
            },
        ],
    });
    assert.deepEqual(
        (await fetchSessionGuardrails(hub, "sess-filter")).map((item) => item.text),
        ["keep this"],
    );
});

test("saveGuardrail: stores with sessionId + privacyLevel internal", async () => {
    const hub = hubStub();
    const sid = "sess-R";
    let saved: any; // reassigned inside the save stub below
    (hub as any).save = (obs: any) => {
        saved = obs;
        return Promise.resolve("id-1");
    };
    await saveGuardrail(hub, sid, "  never edit the Razor markup  ");
    assert.equal(saved.sessionId, sid, "sessionId field set");
    assert.equal(saved.privacyLevel, "internal", "privacyLevel internal (session-scoped)");
    assert.equal(saved.type, "guardrail");
    assert.equal(saved.summary, "never edit the Razor markup", "text trimmed + stored as summary");
    assert.ok(
        !saved.tags || !saved.tags.includes("symposium-session"),
        "no legacy symposium-session tag",
    );
});

test("saveGuardrail: rejects empty and oversized policy text", async () => {
    const hub = hubStub();
    await assert.rejects(() => saveGuardrail(hub, "sess-limit", "   "), /text is required/);
    await assert.rejects(
        () => saveGuardrail(hub, "sess-limit", "x".repeat(1001)),
        /exceeds 1000 characters/,
    );
});

test("guardrail tools remain available without Hub and are approval-gated", () => {
    const names = buildTurnTools(false, false).map((item: any) => item.function?.name ?? item.name);
    assert.ok(names.includes("add_guardrail"));
    assert.ok(names.includes("clear_guardrails"));
    assert.ok(!names.includes("web_search"));
    assert.equal(classifyTool("add_guardrail"), "destructive");
});

test("prepareDispatch reloads guardrails for non-role-aware adapters", async () => {
    let reloads = 0;
    const hub = hubStub({ configured: false });
    await prepareDispatch(
        {
            adapter: { roleAware: () => false } as any,
            sessionId: "sess-cli",
            hub,
            options: { cwd: "/tmp" },
            reloadGuardrails: () => {
                reloads++;
                return Promise.resolve();
            },
            reloadTasks: () => Promise.resolve(),
            getInjectedCheckpointId: () => undefined,
            setInjectedCheckpointId: () => undefined,
        },
        { text: "continue", attachments: [], mode: "send" },
    );
    assert.equal(reloads, 1);
});

test("removeGuardrail: soft-deletes (past expiry) so the item drops from the list", async () => {
    const hub = hubStub();
    const sid = "sess-D";
    const id = await saveGuardrail(hub, sid, "rule to remove");
    const items = await fetchSessionGuardrails(hub, sid);
    assert.equal(items.length, 1);
    const removed = await removeGuardrail(hub, id);
    assert.equal(removed, true);
    const rec = await hub.getByIds([id]);
    assert.ok(rec[0].expiresAtUtc, "expiry set");
    assert.ok(Date.parse(rec[0].expiresAtUtc) < Date.now(), "expiry is in the past (soft delete)");
});

test("clearSessionGuardrails: removes all of the session's guardrails", async () => {
    const hub = hubStub();
    const sid = "sess-C";
    await saveGuardrail(hub, sid, "one");
    await saveGuardrail(hub, sid, "two");
    const n = await clearSessionGuardrails(hub, sid);
    assert.equal(n, 2, "cleared both");
});

test("reloadGuardrails: fills the cache with texts and marks loaded", async () => {
    const sid = "sess-L";
    const hub = hubStub({
        records: [
            {
                id: "a",
                type: "guardrail",
                sessionId: "sess-L",
                summary: "alpha",
                createdAtUtc: "2026-01-03T10:00:00Z",
            },
            {
                id: "b",
                type: "guardrail",
                sessionId: "sess-L",
                summary: "beta",
                createdAtUtc: "2026-01-03T11:00:00Z",
            },
        ],
    });
    const state: any = { guardrails: [], guardrailsLoaded: false, pendingTasks: [] };
    const ctx: HubStateContext = { sessionId: () => sid, hub: () => hub, state };
    await reloadGuardrails(ctx);
    assert.deepEqual(state.guardrails, ["alpha", "beta"]);
    assert.equal(state.guardrailsLoaded, true);
});

test("reloadGuardrails: does NOT mark loaded / wipe cache when the hub throws (so next dispatch retries)", async () => {
    const sid = "sess-X";
    const hub = hubStub({ searchThrows: true });
    const state: any = { guardrails: ["pre-existing"], guardrailsLoaded: false, pendingTasks: [] };
    const ctx: HubStateContext = { sessionId: () => sid, hub: () => hub, state };
    await reloadGuardrails(ctx);
    assert.deepEqual(
        state.guardrails,
        ["pre-existing"],
        "prior cache preserved on transient failure",
    );
    assert.equal(state.guardrailsLoaded, false, "flag stays false so the next dispatch retries");
});

test("reloadGuardrails: empty result still marks loaded (not a failure)", async () => {
    const sid = "sess-E";
    const hub = hubStub({ records: [] });
    const state: any = { guardrails: ["stale"], guardrailsLoaded: false, pendingTasks: [] };
    const ctx: HubStateContext = { sessionId: () => sid, hub: () => hub, state };
    await reloadGuardrails(ctx);
    assert.deepEqual(state.guardrails, []);
    assert.equal(state.guardrailsLoaded, true);
});
