import { test } from "node:test";
import assert from "node:assert/strict";
import { makeLogicalTurnId, makeAttemptId, parseTurnSeq, parseAttemptNo } from "../adapters/openai/turnId";

// --- Entrega 1A: identidade estável de turno (não reseta no reopen) ---
// O defeito: turnNo era um contador in-memory que zerava a cada reopen, então a
// sessão ce8109bf reiniciou a numeração 3x. logicalTurnId é estável (sessionId +
// seq persistido), e attemptId distingue cada POST dentro de um turno.

test("makeLogicalTurnId is deterministic and readable", () => {
    const id = makeLogicalTurnId("sess-abc", 3);
    assert.equal(id, "sess-abc/turn-3");
    // Same inputs → same id (stable, not random).
    assert.equal(makeLogicalTurnId("sess-abc", 3), "sess-abc/turn-3");
});

test("makeAttemptId nests under the logical turn", () => {
    const logical = makeLogicalTurnId("sess-abc", 3);
    assert.equal(makeAttemptId(logical, 1), "sess-abc/turn-3/attempt-1");
    assert.equal(makeAttemptId(logical, 2), "sess-abc/turn-3/attempt-2");
});

test("parseTurnSeq extracts the sequence from a logicalTurnId", () => {
    assert.equal(parseTurnSeq("sess-abc/turn-15"), 15);
    assert.equal(parseTurnSeq("sess-abc/turn-1"), 1);
});

test("parseTurnSeq returns undefined for legacy ids missing the turn segment", () => {
    // Legacy rows written before logicalTurnId existed have no turn- segment.
    assert.equal(parseTurnSeq(undefined), undefined);
    assert.equal(parseTurnSeq(null), undefined);
    assert.equal(parseTurnSeq("just-a-uuid-without-segment"), undefined);
});

test("parseTurnSeq is robust to a sessionId that itself contains /turn-", () => {
    // Use lastIndexOf so a session id containing the separator doesn't fool parsing.
    const id = makeLogicalTurnId("weird/turn-id/turn", 7);
    assert.equal(parseTurnSeq(id), 7);
});

test("parseAttemptNo extracts the attempt number", () => {
    assert.equal(parseAttemptNo("sess/turn-3/attempt-1"), 1);
    assert.equal(parseAttemptNo("sess/turn-3/attempt-12"), 12);
    assert.equal(parseAttemptNo(undefined), undefined);
    assert.equal(parseAttemptNo("sess/turn-3"), undefined);
});

test("parseTurnSeq rejects non-positive / non-numeric seqs", () => {
    assert.equal(parseTurnSeq("sess/turn-0"), undefined);
    assert.equal(parseTurnSeq("sess/turn-abc"), undefined);
    assert.equal(parseTurnSeq("sess/turn--1"), undefined);
});
