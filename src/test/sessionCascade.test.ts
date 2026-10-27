import { test } from "node:test";
import assert from "node:assert/strict";
import {
    expandBulkCascadeTargets,
    expandSessionCascadeTargets,
    type SessionCascadeTarget,
} from "../ui/surfaceSessionCascade";

function session(
    sessionId: string,
    extra: Partial<SessionCascadeTarget> = {},
): SessionCascadeTarget {
    return { sessionId, backend: "claude", ...extra };
}

test("root session drags lineage mates and its own descendants, not their children", () => {
    const sessions = [
        session("root-a", { lineageId: "L1" }),
        session("root-b", { lineageId: "L1" }), // edit branch of the same conversation
        session("child-a1", { parentId: "root-a" }),
        session("grandchild", { parentId: "child-a1" }),
        session("child-b1", { parentId: "root-b" }),
        session("other", { lineageId: "L2" }),
    ];
    const targets = expandSessionCascadeTargets(sessions[0], sessions);
    assert.deepEqual(
        targets.map((t) => t.sessionId).sort(),
        ["root-a", "root-b", "child-a1", "grandchild"].sort(),
    );
});

test("subagent child cascades only to itself and its own descendants", () => {
    const sessions = [
        session("root-a", { lineageId: "L1" }),
        session("child-a1", { parentId: "root-a" }),
        session("grandchild", { parentId: "child-a1" }),
    ];
    const targets = expandSessionCascadeTargets(sessions[1], sessions);
    assert.deepEqual(
        targets.map((t) => t.sessionId).sort(),
        ["child-a1", "grandchild"].sort(),
    );
});

test("root without lineageId expands only to itself and its descendants", () => {
    const sessions = [session("solo-root"), session("kid", { parentId: "solo-root" })];
    const targets = expandSessionCascadeTargets(sessions[0], sessions);
    assert.deepEqual(
        targets.map((t) => t.sessionId).sort(),
        ["solo-root", "kid"].sort(),
    );
});

test("bulk expansion unions overlapping cascades, dedupes and skips unknown ids", () => {
    const sessions = [
        session("root-a", { lineageId: "L1" }),
        session("root-b", { lineageId: "L1" }),
        session("child-a1", { parentId: "root-a" }),
        session("solo"),
    ];
    const targets = expandBulkCascadeTargets(
        [
            { sessionId: "root-a", backend: "claude" },
            { sessionId: "child-a1", backend: "claude" },
            { sessionId: "solo", backend: "claude" },
            { sessionId: "missing", backend: "claude" },
        ],
        sessions,
    );
    assert.deepEqual(
        targets.map((t) => t.sessionId).sort(),
        ["root-a", "root-b", "child-a1", "solo"].sort(),
    );
});
