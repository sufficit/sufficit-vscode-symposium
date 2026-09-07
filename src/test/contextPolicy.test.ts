import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeContextPolicy, contextPolicyDefaults } from "../adapters/openai/contextPolicy";
import { windowMessages } from "../adapters/openai/requestWindow";
import { dumpToText, type SessionDump } from "../sessionReader";
import type { ChatMessage } from "../adapters/openai/types";

test("invalid context settings fall back; valid custom settings survive", () => {
    assert.deepEqual(
        normalizeContextPolicy({ compactionTailMessages: -2, summaryTargetTokens: Infinity }),
        contextPolicyDefaults,
    );
    assert.equal(
        normalizeContextPolicy({ summaryToolCharacters: 1733, historyNotice: false })
            .summaryToolCharacters,
        1733,
    );
    assert.equal(normalizeContextPolicy({ historyNotice: false }).historyNotice, false);
});

test("a small request window retains the latest user and its full tool exchange without mutating history", () => {
    const messages: ChatMessage[] = [
        { role: "system", content: "trusted" },
        { role: "user", content: "old" },
        { role: "assistant", content: "old answer" },
        { role: "user", content: "current cancellation" },
        {
            role: "assistant",
            content: "",
            tool_calls: [
                { id: "a", type: "function", function: { name: "read", arguments: "{}" } },
            ],
        },
        { role: "tool", tool_call_id: "a", content: "result" },
    ];
    const original = JSON.stringify(messages);
    const selected = windowMessages(messages, 1);
    assert.equal(selected[1].content, "current cancellation");
    assert.equal(selected.length, 4);
    assert.equal(JSON.stringify(messages), original);
});

test("paged reads can reconstruct every original character including old tool results", () => {
    const dump: SessionDump = {
        id: "test",
        source: "ledger",
        count: 2,
        messages: [
            { role: "tool", text: "original-result-".repeat(500) },
            { role: "user", text: "latest" },
        ],
    };
    const full = dumpToText(dump, { maxChars: 100000 }).split("\n\n").slice(1).join("\n\n");
    let recovered = "";
    let offset = 0;
    for (;;) {
        const page = dumpToText(dump, { maxChars: 113, offset });
        const [metadata, ...content] = page.split("\n\n");
        recovered += content.join("\n\n");
        const next = /next_char_offset=(\d+|end)/.exec(metadata)![1];
        if (next === "end") break;
        offset = Number(next);
    }
    assert.equal(recovered, full);
});

test("history cursors stay relative to original text as the session count grows", () => {
    const dump: SessionDump = {
        id: "test",
        source: "ledger",
        count: 9,
        messages: [{ role: "tool", text: "original-".repeat(50) }],
    };
    const before = dumpToText(dump, { maxChars: 23, offset: 50 });
    dump.messages.push({ role: "user", text: "new message" });
    dump.count = 10;
    const after = dumpToText(dump, { maxChars: 23, offset: 50, tail: 1 });
    assert.equal(
        before.split("\n\n").slice(1).join("\n\n"),
        after.split("\n\n").slice(1).join("\n\n"),
    );
});
