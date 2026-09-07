import assert from "node:assert/strict";
import test from "node:test";
import { ApprovalState } from "../adapters/openai/approvalState";
import type { AgentEvent, SessionStartOptions } from "../adapters/types";

test("admin approval state never emits a prompt or pauses a destructive tool", async () => {
    const events: AgentEvent[] = [];
    const options: SessionStartOptions = { cwd: process.cwd(), permission: "admin" };
    const approvals = new ApprovalState(options, (event) => events.push(event));

    const approved = await approvals.request(
        "admin-shell",
        "shell",
        "run contained command",
        "destructive",
    );

    assert.equal(approved, true);
    assert.deepEqual(events, []);
});
