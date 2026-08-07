import assert from "node:assert/strict";
import test from "node:test";
import { stableSessionKey } from "../application/sessionIdentity";

test("stable session key prefers the visible resume id over a canonical native id", () => {
    assert.equal(stableSessionKey("parent/subagents/child", "parent"), "parent/subagents/child");
    assert.equal(stableSessionKey(undefined, "native-session"), "native-session");
});
