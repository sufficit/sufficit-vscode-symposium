import assert from "node:assert/strict";
import test from "node:test";
import type { AgentAdapter, AdapterQuotaSnapshot } from "../adapters/types";
import { SurfaceQuota } from "../ui/surfaceQuota";

function snapshot(): AdapterQuotaSnapshot {
    return {
        backend: "openai",
        displayName: "Sufficit AI",
        windows: [],
        updatedAt: 1,
        state: "ready",
    };
}

test("a blocked quota read times out, stops animating, and never overlaps", async () => {
    const posted: unknown[] = [];
    let reads = 0;
    const adapter = {
        usage: {
            backend: "openai",
            displayName: "Sufficit AI",
            read: () => {
                reads++;
                return new Promise<AdapterQuotaSnapshot>(() => undefined);
            },
        },
    } as AgentAdapter;
    const quota = new SurfaceQuota({
        post: (message) => posted.push(message),
        getModel: () => "development",
        timeoutMilliseconds: 1,
    });

    quota.activate(adapter);
    const sameRefresh = quota.refresh();
    assert.equal(reads, 1, "the interval/manual path must share the active read");
    await sameRefresh;

    const loading = posted.filter(
        (message) => (message as { type?: string }).type === "quota-loading",
    ) as Array<{ loading: boolean; error?: boolean }>;
    assert.deepEqual(
        loading.map(({ loading: value }) => value),
        [true, false],
    );
    assert.equal(loading[1].error, true);
});

test("a completed quota read clears busy once and publishes its snapshot", async () => {
    const posted: unknown[] = [];
    const quota = new SurfaceQuota({
        post: (message) => posted.push(message),
        getModel: () => undefined,
    });
    quota.activate({
        usage: {
            backend: "openai",
            displayName: "Sufficit AI",
            read: () => Promise.resolve(snapshot()),
        },
    } as AgentAdapter);
    await quota.refresh();

    assert.equal(
        posted.filter(
            (message) =>
                (message as { type?: string; loading?: boolean }).type === "quota-loading" &&
                (message as { loading?: boolean }).loading === false,
        ).length,
        1,
    );
    assert.equal(
        posted.some(
            (message) =>
                (message as { type?: string; event?: { kind?: string } }).type === "event" &&
                (message as { event?: { kind?: string } }).event?.kind === "quota",
        ),
        true,
    );
});
