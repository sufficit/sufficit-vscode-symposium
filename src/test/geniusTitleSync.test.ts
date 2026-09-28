import assert from "node:assert/strict";
import test from "node:test";
import type { SessionInfo } from "../adapters/types";
import { GeniusTitleSync } from "../sessions/geniusTitleSync";

const id = "11111111-2222-4333-8444-555555555555";
const info = (title: string): SessionInfo => ({ backend: "genius", sessionId: id, title });

test("Symposium rename updates Genius and clears the local override after success", async () => {
    let native = info("Desktop title");
    let local: string | undefined = "Old Symposium title";
    let cached = info("Desktop title");
    let refreshes = 0;
    const sync = new GeniusTitleSync(
        {
            listSessions: () => Promise.resolve([native]),
            renameSession: (_session, title) => {
                native = info(title);
                return Promise.resolve();
            },
        },
        {
            customTitle: () => local,
            setTitle: (_session, title) => {
                local = title;
                return Promise.resolve();
            },
        },
        {
            listCached: () => [cached],
            reconcile: () => {
                cached = native;
                return Promise.resolve([cached]);
            },
        },
        () => {
            refreshes++;
        },
    );
    await sync.rename(info("Old Symposium title"), "Shared title");
    assert.equal(native.title, "Shared title");
    assert.equal(local, undefined);
    assert.equal(cached.title, "Shared title");
    assert.equal(refreshes, 1);
});

test("Desktop rename refreshes Symposium and legacy local titles migrate once", async () => {
    let native = info("Desktop title");
    let local: string | undefined = "Legacy Symposium title";
    let cached = info("Desktop title");
    let writes = 0;
    let refreshes = 0;
    const sync = new GeniusTitleSync(
        {
            listSessions: () => Promise.resolve([native]),
            renameSession: (_session, title) => {
                writes++;
                native = info(title);
                return Promise.resolve();
            },
        },
        {
            customTitle: () => local,
            setTitle: (_session, title) => {
                local = title;
                return Promise.resolve();
            },
        },
        {
            listCached: () => [cached],
            reconcile: () => {
                cached = native;
                return Promise.resolve([cached]);
            },
        },
        () => {
            refreshes++;
        },
    );
    await sync.poll();
    assert.equal(native.title, "Legacy Symposium title");
    assert.equal(local, undefined);
    assert.equal(writes, 1);

    native = info("Renamed in Desktop");
    await sync.poll();
    assert.equal(cached.title, "Renamed in Desktop");
    assert.equal(writes, 1);
    assert.equal(refreshes, 2);
});

test("failed native rename keeps the Symposium override", async () => {
    let local: string | undefined = "Legacy Symposium title";
    const sync = new GeniusTitleSync(
        {
            listSessions: () => Promise.resolve([info("Desktop title")]),
            renameSession: () => Promise.reject(new Error("unavailable")),
        },
        {
            customTitle: () => local,
            setTitle: (_session, title) => {
                local = title;
                return Promise.resolve();
            },
        },
        {
            listCached: () => [info("Desktop title")],
            reconcile: () => Promise.resolve([info("Desktop title")]),
        },
        () => undefined,
    );
    await assert.rejects(sync.poll(), /unavailable/);
    assert.equal(local, "Legacy Symposium title");
});
