import test from "node:test";
import assert from "node:assert/strict";
import type { AgentAdapter, SessionInfo } from "../adapters/types";
import { SessionIndex } from "../sessions/index";
import { InMemorySessionRepository } from "../sessions/memoryRepository";

function info(
    backend: string,
    sessionId: string,
    title: string,
    transcriptPath?: string,
): SessionInfo {
    return { backend, sessionId, title, updatedAt: new Date(1000), transcriptPath };
}

function stored(info: SessionInfo) {
    return { ...info, updatedAt: info.updatedAt?.getTime() };
}

/** Adapter whose next (and later) scans can be blocked until released. */
function fakeAdapter(backend: string, session: SessionInfo) {
    let scans = 0;
    let gate: Promise<void> | undefined;
    const adapter = {
        backend,
        listSessions: async (): Promise<SessionInfo[]> => {
            scans++;
            if (gate) await gate;
            return [session];
        },
    };
    return {
        adapter: adapter as unknown as AgentAdapter,
        scans: () => scans,
        block: () => {
            let release!: () => void;
            gate = new Promise<void>((resolve) => {
                release = resolve;
            });
            return release;
        },
    };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function makeIndex(adapters: AgentAdapter[], preloaded: SessionInfo[] = []) {
    const repository = new InMemorySessionRepository();
    if (preloaded.length) {
        repository.replaceAll(preloaded.map(stored));
    }
    return new SessionIndex({ storageDir: "/unused", adapters, repository });
}

test("invalidate({ backend }) rescans only the affected backend", async () => {
    const claude = fakeAdapter("claude", info("claude", "c1", "Claude one"));
    const codex = fakeAdapter("codex", info("codex", "x1", "Codex one"));
    const index = makeIndex([claude.adapter, codex.adapter]);

    index.invalidate({ backend: "claude" });
    await tick();

    assert.equal(claude.scans(), 1);
    assert.equal(codex.scans(), 0);
    assert.equal(index.get("claude", "c1")?.title, "Claude one");
    assert.equal(index.get("codex", "x1"), undefined);
});

test("invalidations arriving during a targeted scan coalesce into the next drain", async () => {
    const claude = fakeAdapter("claude", info("claude", "c1", "Claude"));
    const codex = fakeAdapter("codex", info("codex", "x1", "Codex"));
    const genius = fakeAdapter("genius", info("genius", "g1", "Genius"));
    const index = makeIndex([claude.adapter, codex.adapter, genius.adapter]);
    const releaseClaude = claude.block();

    index.invalidate({ backend: "claude" });
    await tick();
    assert.equal(claude.scans(), 1);

    index.invalidate({ backend: "codex" });
    index.invalidate({ backend: "genius" });
    await tick();
    assert.equal(codex.scans(), 0);
    assert.equal(genius.scans(), 0);

    releaseClaude();
    await tick();
    await tick();

    assert.equal(claude.scans(), 1);
    assert.equal(codex.scans(), 1);
    assert.equal(genius.scans(), 1);
    assert.equal(index.get("codex", "x1")?.title, "Codex");
});

test("a targeted rescan waits for an in-flight reconcile instead of racing it", async () => {
    const claude = fakeAdapter("claude", info("claude", "c1", "Claude"));
    const index = makeIndex([claude.adapter]);
    const release = claude.block();

    const reconciling = index.reconcile();
    await tick();
    assert.equal(claude.scans(), 1);

    index.invalidate({ backend: "claude" });
    await tick();
    assert.equal(claude.scans(), 1);

    release();
    await reconciling;
    await tick();
    await tick();

    assert.equal(claude.scans(), 2);
    assert.equal(index.get("claude", "c1")?.title, "Claude");
});

test("invalidate({ sessionId }) targets the single owning backend", async () => {
    const claude = fakeAdapter("claude", info("claude", "c1", "Claude one"));
    const codex = fakeAdapter("codex", info("codex", "x1", "Codex one"));
    const index = makeIndex(
        [claude.adapter, codex.adapter],
        [info("claude", "c1", "Claude one", "/tmp/c1.jsonl")],
    );

    index.invalidate({ sessionId: "c1" });
    await tick();

    assert.equal(claude.scans(), 1);
    assert.equal(codex.scans(), 0);
});

test("invalidate({ sessionId }) with an unknown id rescans every backend", async () => {
    const claude = fakeAdapter("claude", info("claude", "c1", "Claude one"));
    const codex = fakeAdapter("codex", info("codex", "x1", "Codex one"));
    const index = makeIndex([claude.adapter, codex.adapter]);

    index.invalidate({ sessionId: "who-knows" });
    await tick();

    assert.equal(claude.scans(), 1);
    assert.equal(codex.scans(), 1);
});

test("invalidate({ path }) rescans only backends owning that transcript", async () => {
    const claude = fakeAdapter("claude", info("claude", "c1", "Claude one"));
    const codex = fakeAdapter("codex", info("codex", "x1", "Codex one"));
    const index = makeIndex(
        [claude.adapter, codex.adapter],
        [info("claude", "c1", "Claude one", "/tmp/c1.jsonl")],
    );

    index.invalidate({ path: "/tmp/c1.jsonl" });
    await tick();

    assert.equal(claude.scans(), 1);
    assert.equal(codex.scans(), 0);
});

test("invalidate() without a change queues every backend (manual refresh)", async () => {
    const claude = fakeAdapter("claude", info("claude", "c1", "Claude one"));
    const codex = fakeAdapter("codex", info("codex", "x1", "Codex one"));
    const index = makeIndex([claude.adapter, codex.adapter]);

    index.invalidate();
    await tick();

    assert.equal(claude.scans(), 1);
    assert.equal(codex.scans(), 1);
});

test("invalidate after dispose bumps the generation without scanning", async () => {
    const claude = fakeAdapter("claude", info("claude", "c1", "Claude one"));
    const index = makeIndex([claude.adapter]);
    await index.dispose();

    index.invalidate({ backend: "claude" });
    await tick();

    assert.equal(claude.scans(), 0);
});
