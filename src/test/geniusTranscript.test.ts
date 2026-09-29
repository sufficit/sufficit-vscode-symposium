import assert from "node:assert/strict";
import test from "node:test";
import { geniusTranscriptMessages } from "../adapters/genius/transcript";

test("genius transcript maps persisted parts to history rows", () => {
    const messages = geniusTranscriptMessages([
        { kind: "User", text: "check locks", createdAt: "2026-09-28T18:28:43Z" },
        { kind: "Reasoning", text: "thinking" },
        {
            kind: "ToolCall",
            text: 'fs_read({"path":"/etc/my.cnf"}) → [mysqld] a) → b',
        },
        { kind: "ToolCall", text: 'shell({"command":"ls"})' },
        { kind: "Markdown", text: "Found it." },
        { kind: "Markdown", text: "" },
        { kind: "User", text: "old", expired: true },
        { kind: "Action", text: "ignored" },
        null,
    ]);

    assert.deepEqual(
        messages.map((message) => message.role),
        ["user", "thinking", "tool", "tool", "assistant", "user"],
    );
    assert.equal(messages[0]!.ts, Date.parse("2026-09-28T18:28:43Z"));
    assert.equal(messages[2]!.toolName, "fs_read");
    assert.equal(messages[2]!.input, '{"path":"/etc/my.cnf"}');
    assert.equal(messages[2]!.result, "[mysqld] a) → b");
    assert.equal(messages[3]!.toolName, "shell");
    assert.equal(messages[3]!.result, undefined);
    assert.equal(messages[5]!.text, "(expired)");
});
