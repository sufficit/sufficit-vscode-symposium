import { test } from "node:test";
import assert from "node:assert/strict";
import {
    normalizeContextPolicy,
    contextPolicyDefaults,
    selectRequestHistory,
} from "../adapters/openai/contextPolicy";
import { windowMessages } from "../adapters/openai/requestWindow";
import { dumpToText, type SessionDump } from "../sessionReader";
import type { ChatMessage, OpenAIAdapterConfig } from "../adapters/openai/types";

test("omission notices identify recoverable history and honor provider roles and opt-out", () => {
    const messages: ChatMessage[] = [
        { role: "user", content: "old request" },
        { role: "assistant", content: "old answer" },
        { role: "user", content: "cancel the old request" },
    ];
    const original = structuredClone(messages);
    const cfg: OpenAIAdapterConfig = {
        api: "chat",
        baseUrl: "https://example.test",
        model: "test",
        models: [],
        headers: {},
        maxHistoryMessages: 1,
    };
    const deps = { cfg, sessionId: "original-session" };
    const request = selectRequestHistory(messages, 3, deps);
    assert.equal(request[0].role, "developer");
    assert.match(String(request[0].content), /1 of 3.*original-session.*read_session/);
    assert.match(String(request[0].content), /cancellations still apply/);
    assert.equal(request[1].content, "cancel the old request");
    assert.equal(
        selectRequestHistory(messages, 3, {
            ...deps,
            cfg: { ...cfg, supportsDeveloperRole: false },
        })[0].role,
        "system",
    );
    const disabled = selectRequestHistory(messages, 3, {
        ...deps,
        cfg: { ...cfg, contextPolicy: { historyNotice: false } },
    });
    assert.deepEqual(disabled, [messages[2]]);
    assert.deepEqual(
        selectRequestHistory(messages, 3, { ...deps, cfg: { ...cfg, maxHistoryMessages: 0 } }),
        messages,
    );
    assert.deepEqual(messages, original);
});

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
