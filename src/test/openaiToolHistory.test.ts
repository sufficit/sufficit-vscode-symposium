import { test } from "node:test";
import assert from "node:assert/strict";
import { ChatMessage } from "../adapters/openai/types";
import { findToolHistoryIssues, materializeToolSafeHistory } from "../adapters/openai/toolHistory";
import { mergeToolDefinitions } from "../adapters/openai/toolMerge";
import {
    activeRepeatedToolCallFingerprint,
    appendRepeatedToolCallFeedback,
    REPEAT_TOOL_CALL_LIMIT,
    repeatedToolCallWithoutProgress,
    toolCallBatchFingerprint,
} from "../adapters/openai/turnNotices";

test("materializeToolSafeHistory supplies a request-only result for missing tool calls", () => {
    const messages: ChatMessage[] = [
        { role: "system", content: "system" },
        { role: "user", content: "run tools" },
        {
            role: "assistant",
            content: null,
            tool_calls: [
                {
                    id: "call_missing",
                    type: "function",
                    function: { name: "missing", arguments: "{}" },
                },
                {
                    id: "call_present",
                    type: "function",
                    function: { name: "present", arguments: "{}" },
                },
            ],
        },
        { role: "tool", tool_call_id: "call_present", name: "present", content: "ok" },
    ];

    const materialized = materializeToolSafeHistory(messages);

    assert.equal(materialized.foldedOrphanTools, 0);
    assert.equal(materialized.foldedMissingToolCalls, 0);
    assert.equal(materialized.repairedMissingToolCalls, 1);
    assert.deepEqual(
        materialized.messages[2].tool_calls?.map((toolCall) => toolCall.id),
        ["call_missing", "call_present"],
    );
    assert.equal(materialized.messages[3].role, "tool");
    assert.equal(materialized.messages[3].tool_call_id, "call_missing");
    assert.match(String(materialized.messages[3].content), /was not executed/);
    assert.deepEqual(findToolHistoryIssues(materialized.messages), []);
});

test("repeated tool-call guard stops before an unmatched tool call is persisted", () => {
    const recent: string[] = [];
    const signature = 'read_file:{"path":"/repo/file.ts"}';

    for (let i = 1; i < REPEAT_TOOL_CALL_LIMIT; i++) {
        assert.equal(
            repeatedToolCallWithoutProgress(recent, signature),
            false,
            `call ${i} must remain executable`,
        );
    }
    assert.equal(repeatedToolCallWithoutProgress(recent, signature), true);
    assert.deepEqual(recent, Array(REPEAT_TOOL_CALL_LIMIT).fill(signature));
});

test("repeated tool-call guard catches an interleaved A/B loop", () => {
    const recent: string[] = [];
    const first = 'read_file:{"path":"/repo/current.service"}';
    const second = 'read_file:{"path":"/repo/missing.service"}';

    for (let i = 1; i < REPEAT_TOOL_CALL_LIMIT; i++) {
        assert.equal(
            repeatedToolCallWithoutProgress(recent, first),
            false,
            `first call ${i} must remain executable`,
        );
        assert.equal(
            repeatedToolCallWithoutProgress(recent, second),
            false,
            `second call ${i} must remain executable`,
        );
    }

    assert.equal(repeatedToolCallWithoutProgress(recent, first), true);
    assert.equal(recent.filter((call) => call === first).length, REPEAT_TOOL_CALL_LIMIT);
    assert.equal(recent.filter((call) => call === second).length, REPEAT_TOOL_CALL_LIMIT - 1);
});

test("repeated tool-call guard forgets occurrences outside its recent window", () => {
    const recent: string[] = [];
    const repeated = 'read_file:{"path":"/repo/reused.ts"}';

    for (let i = 0; i < REPEAT_TOOL_CALL_LIMIT - 1; i++) {
        assert.equal(repeatedToolCallWithoutProgress(recent, repeated), false);
        assert.equal(repeatedToolCallWithoutProgress(recent, `other:${i}:a`), false);
        assert.equal(repeatedToolCallWithoutProgress(recent, `other:${i}:b`), false);
    }

    assert.equal(repeatedToolCallWithoutProgress(recent, repeated), false);
    assert.equal(recent.filter((call) => call === repeated).length, 4);
});

test("repeated tool-call feedback is durable model context without exposing arguments", () => {
    const signature = 'read_file:{"path":"/private/token.json"}';
    const messages: ChatMessage[] = [
        { role: "user", content: "inspect" },
        {
            role: "assistant",
            content: null,
            tool_calls: [
                {
                    id: "call_1",
                    type: "function",
                    function: { name: "read_file", arguments: "{}" },
                },
            ],
        },
        { role: "tool", tool_call_id: "call_1", name: "read_file", content: "result" },
    ];
    const feedback = appendRepeatedToolCallFeedback(messages, signature, ["read_file"], true);
    assert.equal(feedback.role, "developer");
    assert.match(String(feedback.content), /read_file call batch was requested 6 times/);
    assert.doesNotMatch(String(feedback.content), /private|token\.json/);
    assert.deepEqual(findToolHistoryIssues(messages), []);
    messages.push(
        { role: "developer", content: "one-shot preamble" },
        { role: "user", content: "continue" },
    );
    assert.equal(activeRepeatedToolCallFingerprint(messages), toolCallBatchFingerprint(signature));
});

test("repeated tool-call carryover expires after assistant progress", () => {
    const signature = "read_file:{}";
    const messages: ChatMessage[] = [];
    appendRepeatedToolCallFeedback(messages, signature, ["read_file"], false);
    assert.equal(messages[0].role, "system");
    messages.push({ role: "user", content: "continue" });
    messages.push({ role: "assistant", content: "Used the existing result." });
    messages.push({ role: "user", content: "new task" });
    assert.equal(activeRepeatedToolCallFingerprint(messages), undefined);
    assert.notEqual(
        toolCallBatchFingerprint(signature),
        toolCallBatchFingerprint('read_file:{"path":"other"}'),
    );
});

test("mergeToolDefinitions prefixes collisions without mutating shared tool defs", () => {
    const symTool = {
        type: "function",
        function: {
            name: "search",
            description: "Search memory",
        },
    };
    const localTool = {
        type: "function",
        function: {
            name: "search",
            description: "Search files",
        },
    };

    const merged = mergeToolDefinitions([
        { tool: symTool, source: "sym_" },
        { tool: localTool, source: "local_" },
    ]);

    assert.deepEqual(
        merged.map((tool) => tool.function?.name),
        ["sym_search", "local_search"],
    );
    assert.equal(symTool.function.name, "search");
    assert.equal(symTool.function.description, "Search memory");
    assert.equal(localTool.function.name, "search");
    assert.equal(localTool.function.description, "Search files");
    assert.notEqual(merged[0], symTool);
    assert.notEqual(merged[0].function, symTool.function);
});
