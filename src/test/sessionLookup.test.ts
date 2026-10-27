import test from "node:test";
import assert from "node:assert/strict";
import type { SessionInfo } from "../adapters/types";
import { createSessionLookup, SessionLookupDeps } from "../sessions/sessionLookup";

const indexed: SessionInfo = {
    backend: "claude",
    sessionId: "sess-1",
    title: "Indexed title",
    updatedAt: new Date(1000),
};

function makeDeps(
    live: SessionInfo[] = [],
    opts: {
        index?: Map<string, SessionInfo>;
        decorate?: (sessions: SessionInfo[]) => SessionInfo[];
        status?: "working" | "idle";
    } = {},
): SessionLookupDeps {
    return {
        runtime: {
            liveInfos: () => live,
            statusFor: () => opts.status,
        } as unknown as SessionLookupDeps["runtime"],
        store: {
            decorate: opts.decorate ?? ((sessions: SessionInfo[]) => sessions),
        },
        indexGet: opts.index
            ? (backend: string, sessionId: string) => opts.index?.get(`${backend}/${sessionId}`)
            : undefined,
    };
}

test("createSessionLookup resolves a live session without touching the index", () => {
    const live = { ...indexed, title: "Live title", status: "working" as const };
    const index = new Map([["claude/sess-1", indexed]]);
    const lookup = createSessionLookup(makeDeps([live], { index }));

    const info = lookup("claude", "sess-1");

    assert.ok(info);
    assert.equal(info.title, "Live title");
    assert.equal(info.status, "working");
    assert.ok(info.updatedAt);
});

test("createSessionLookup decorates an indexed session with user metadata and status", () => {
    const decorate = (sessions: SessionInfo[]) =>
        sessions.map((s) => ({ ...s, title: "Custom title", archived: true }));
    const index = new Map([["claude/sess-1", indexed]]);
    const lookup = createSessionLookup(makeDeps([], { index, decorate, status: "idle" }));

    const info = lookup("claude", "sess-1");

    assert.ok(info);
    assert.equal(info.title, "Custom title");
    assert.equal(info.archived, true);
    assert.equal(info.status, "idle");
});

test("createSessionLookup returns undefined for unknown ids instead of scanning", () => {
    const lookup = createSessionLookup(makeDeps());

    assert.equal(lookup("claude", "missing"), undefined);
});

test("createSessionLookup drops sessions removed by decoration (permanent delete)", () => {
    const index = new Map([["claude/sess-1", indexed]]);
    const lookup = createSessionLookup(makeDeps([], { index, decorate: () => [] }));

    assert.equal(lookup("claude", "sess-1"), undefined);
});
