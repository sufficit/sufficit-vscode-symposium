import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { connectSessionIndexTriggers } from "../extension/sessionIndexTriggers";
import type { SessionInfo } from "../adapters/types";

interface RecordedInvalidation {
    sessionId?: string;
    path?: string;
    backend?: string;
}

function fakeStore() {
    let listener: ((sessionId: string) => void) | undefined;
    return {
        setMutationListener(l?: (sessionId: string) => void) {
            listener = l;
        },
        mutate(sessionId: string) {
            listener?.(sessionId);
        },
    };
}

function fakeIndex(listed: SessionInfo[] = []) {
    const invalidations: RecordedInvalidation[] = [];
    return {
        invalidations,
        listCached: () => listed,
        invalidate: (change?: RecordedInvalidation) => invalidations.push(change ?? {}),
    };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() > deadline) {
            throw new Error("waitFor: condition not met in time");
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

test("store mutations fire targeted sessionId invalidations until disposed", () => {
    const store = fakeStore();
    const index = fakeIndex();
    const triggers = connectSessionIndexTriggers({ store, index });

    store.mutate("session-1");
    store.mutate("session-2");
    assert.deepEqual(index.invalidations, [{ sessionId: "session-1" }, { sessionId: "session-2" }]);

    triggers.dispose();
    store.mutate("session-3");
    assert.equal(index.invalidations.length, 2);
});

test("transcript changes observed by the watcher fire path invalidations", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "symposium-triggers-"));
    const file = path.join(dir, "s1.jsonl");
    fs.writeFileSync(file, "{}\n");
    const listed: SessionInfo[] = [
        { backend: "claude", sessionId: "s1", title: "s1", transcriptPath: file },
    ];
    const store = fakeStore();
    const index = fakeIndex(listed);
    const triggers = connectSessionIndexTriggers({
        store,
        index,
        watcher: { debounceMs: 20, resyncIntervalMs: 5_000 },
    });
    try {
        await waitFor(() => triggers.watcher.isWatching(dir));
        fs.appendFileSync(file, "{}\n");
        await waitFor(() => index.invalidations.some((change) => change.path === file));
    } finally {
        triggers.dispose();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("an empty index watches nothing and stays idle", async () => {
    const store = fakeStore();
    const index = fakeIndex();
    const triggers = connectSessionIndexTriggers({
        store,
        index,
        watcher: { debounceMs: 20, resyncIntervalMs: 60 },
    });
    try {
        await new Promise((resolve) => setTimeout(resolve, 150));
        assert.deepEqual(index.invalidations, []);
    } finally {
        triggers.dispose();
    }
});
