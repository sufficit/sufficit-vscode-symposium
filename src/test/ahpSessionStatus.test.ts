import assert from "node:assert/strict";
import test from "node:test";
import type { SessionState, SessionSummary, URI } from "@microsoft/agent-host-protocol";
import { AHP_STATUS, decodeSessionStatus, sessionSummary } from "../ahp";

const RESOURCE = "ahp-session:/11111111-1111-4111-8111-111111111111" as URI;

/** Extra fields sessionSummary() emits beside the raw numeric bitmask (issue #56). */
interface NamedStatusFields {
    statusName: string;
    read: boolean;
    archived: boolean;
}

const DECODE_CASES: Array<[number, string, boolean, boolean]> = [
    [1, "idle", false, false],
    [33, "idle", true, false],
    [34, "error", true, false],
    [40, "working", true, false],
    [24, "inputNeeded", false, false],
    [56, "inputNeeded", true, false],
    [65, "idle", false, true],
    [72, "working", false, true],
    [96, "idle", true, true],
];

test("decodeSessionStatus names the bitmasks clients observe in the wild", () => {
    for (const [status, name, read, archived] of DECODE_CASES) {
        assert.deepEqual(decodeSessionStatus(status), { name, read, archived });
    }
});

test("sessionSummary serializes statusName/read/archived beside the raw bitmask", () => {
    const running = summaryFor(AHP_STATUS.inProgress | AHP_STATUS.isRead);
    assert.equal(running.status, 40);
    const named = namedFields(running);
    assert.equal(named.statusName, "working");
    assert.equal(named.read, true);
    assert.equal(named.archived, false);
});

test("sessionSummary surfaces archived sessions through the named fields", () => {
    const archived = summaryFor(AHP_STATUS.idle | AHP_STATUS.isArchived);
    assert.equal(archived.status, 65);
    const named = namedFields(archived);
    assert.equal(named.statusName, "idle");
    assert.equal(named.read, false);
    assert.equal(named.archived, true);
});

test("sessionSummary keeps inputNeeded readable as its own named status", () => {
    const waiting = summaryFor(AHP_STATUS.inputNeeded | AHP_STATUS.isRead);
    assert.equal(waiting.status, 56);
    const named = namedFields(waiting);
    assert.equal(named.statusName, "inputNeeded");
    assert.equal(named.read, true);
    assert.equal(named.archived, false);
});

function summaryFor(status: number): SessionSummary {
    return sessionSummary(RESOURCE, sessionState(status));
}

function namedFields(summary: SessionSummary): NamedStatusFields {
    return summary as unknown as NamedStatusFields;
}

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
