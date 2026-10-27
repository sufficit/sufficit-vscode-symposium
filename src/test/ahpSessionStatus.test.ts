import assert from "node:assert/strict";
import test from "node:test";
import type { SessionState, URI } from "@microsoft/agent-host-protocol";
import { AHP_STATUS, decodeSessionStatus, sessionSummary } from "../ahp";

const RESOURCE = "ahp-session:/11111111-1111-4111-8111-111111111111" as URI;

interface NamedStatusFields {
    statusName: string;
    read: boolean;
    archived: boolean;
}

test("decodeSessionStatus names the bitmasks clients observe in the wild", () => {
    assert.deepEqual(decodeSessionStatus(1), { name: "idle", read: false, archived: false });
    assert.deepEqual(decodeSessionStatus(33), { name: "idle", read: true, archived: false });
    assert.deepEqual(decodeSessionStatus(34), { name: "error", read: true, archived: false });
    assert.deepEqual(decodeSessionStatus(40), { name: "working", read: true, archived: false });
    assert.deepEqual(decodeSessionStatus(24), {
        name: "inputNeeded",
        read: false,
        archived: false,
    });
    assert.deepEqual(decodeSessionStatus(56), {
        name: "inputNeeded",
        read: true,
        archived: false,
    });
    assert.deepEqual(decodeSessionStatus(65), { name: "idle", read: false, archived: true });
    assert.deepEqual(decodeSessionStatus(72), { name: "working", read: false, archived: true });
    assert.deepEqual(decodeSessionStatus(96), { name: "idle", read: true, archived: true });
});

test("sessionSummary serializes statusName/read/archived beside the raw bitmask", () => {
    const summary = sessionSummary(
        RESOURCE,
        sessionState(AHP_STATUS.inProgress | AHP_STATUS.isRead),
    );
    assert.equal(summary.status, 40);
    const named = summary as unknown as NamedStatusFields;
    assert.equal(named.statusName, "working");
    assert.equal(named.read, true);
    assert.equal(named.archived, false);
});

test("sessionSummary surfaces archived sessions through the named fields", () => {
    const summary = sessionSummary(
        RESOURCE,
        sessionState(AHP_STATUS.idle | AHP_STATUS.isArchived),
    );
    assert.equal(summary.status, 65);
    const named = summary as unknown as NamedStatusFields;
    assert.equal(named.statusName, "idle");
    assert.equal(named.read, false);
    assert.equal(named.archived, true);
});

test("sessionSummary keeps inputNeeded readable as its own named status", () => {
    const summary = sessionSummary(
        RESOURCE,
        sessionState(AHP_STATUS.inputNeeded | AHP_STATUS.isRead),
    );
    assert.equal(summary.status, 56);
    const named = summary as unknown as NamedStatusFields;
    assert.equal(named.statusName, "inputNeeded");
    assert.equal(named.read, true);
    assert.equal(named.archived, false);
});

function sessionState(status: number): SessionState {
    return {
        provider: "codex",
        title: "Named status",
        status,
        workingDirectory: undefined,
        chats: [],
        _meta: { symposium: { nativeSessionId: "native-1" } },
    } as unknown as SessionState;
}
