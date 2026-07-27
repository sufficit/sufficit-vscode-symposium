import { test } from "node:test";
import assert from "node:assert/strict";
import { buildOpenAIModelList } from "../adapters/openaiModels";
import { sanitizeToolParametersForOpenAI } from "../adapters/openaiSchema";
import { compressMessages } from "../compression/webhook";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assessContextWindow, windowMessages } from "../adapters/openai/requestWindow";
import { findToolHistoryIssues, materializeToolSafeHistory } from "../adapters/openai/toolHistory";
import { ChatMessage } from "../adapters/openai/types";
import { mergeToolDefinitions } from "../adapters/openai/toolMerge";
import { consumeStream } from "../adapters/openai/streamConsume";
import { REPEAT_TOOL_CALL_LIMIT, repeatedToolCallWithoutProgress } from "../adapters/openai/turnNotices";

/** Builds a ReadableStream that emits the given SSE text as UTF-8 bytes. */
function sseStream(body: string): ReadableStream<Uint8Array> {
    const bytes = new TextEncoder().encode(body);
    return new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(bytes); controller.close(); },
    });
}

const timing = { requestStartedAt: 0, responseStartedAt: 0 };

test("consumeStream surfaces chat-completions reasoning_content as thinking", async () => {
    const seen: string[] = [];
    const body =
        `data: {"choices":[{"delta":{"reasoning_content":"pondering"}}]}\n` +
        `data: {"choices":[{"delta":{"reasoning_content":" more"}}]}\n` +
        `data: [DONE]\n`;
    const out = await consumeStream(sseStream(body), "m", timing, false, {
        onText: (d) => seen.push(`text:${d}`),
        onReasoning: (d) => seen.push(`reason:${d}`),
        onError: () => {},
    });
    assert.equal(out.text, "");
    assert.equal(out.reasoning, "pondering more");
    assert.deepEqual(seen, ["reason:pondering", "reason: more"]);
});

test("consumeStream surfaces OpenRouter-style delta.reasoning as thinking", async () => {
    const body = `data: {"choices":[{"delta":{"reasoning":"hmm"}}]}\n` + `data: [DONE]\n`;
    const out = await consumeStream(sseStream(body), "m", timing, false, {
        onText: () => {}, onReasoning: () => {}, onError: () => {},
    });
    assert.equal(out.reasoning, "hmm");
});

test("consumeStream surfaces responses-API reasoning_text delta as thinking", async () => {
    const body =
        `data: {"type":"response.reasoning_text.delta","delta":"think"}\n` +
        `data: {"type":"response.output_text.delta","delta":"answer"}\n` +
        `data: [DONE]\n`;
    const out = await consumeStream(sseStream(body), "m", timing, true, {
        onText: () => {}, onReasoning: () => {}, onError: () => {},
    });
    assert.equal(out.reasoning, "think");
    assert.equal(out.text, "answer");
});

test("consumeStream hides gateway think blocks split across content deltas", async () => {
    const seen: string[] = [];
    const body =
        `data: {"choices":[{"delta":{"content":"<thi"}}]}\n` +
        `data: {"choices":[{"delta":{"content":"nk>internal reasoning</think>Resposta"}}]}\n` +
        `data: {"choices":[{"delta":{"content":" final</think>"}}]}\n` +
        `data: [DONE]\n`;
    const out = await consumeStream(sseStream(body), "m", timing, false, {
        onText: (d) => seen.push(d), onReasoning: () => {}, onError: () => {},
    });
    assert.equal(out.text, "Resposta final");
    assert.deepEqual(seen, ["Resposta", " final"]);
});

test("buildOpenAIModelList does not invent OpenAI fallback models", () => {
    assert.deepEqual(buildOpenAIModelList([], ""), []);
    assert.deepEqual(buildOpenAIModelList([], "sufficit-dev"), ["sufficit-dev"]);
});

test("buildOpenAIModelList keeps configured model and configured list", () => {
    assert.deepEqual(
        buildOpenAIModelList(["sufficit-dev", "sufficit-fast"], "sufficit-dev"),
        ["sufficit-dev", "sufficit-fast"],
    );
});

test("sanitizeToolParametersForOpenAI removes unsupported nested schema keys", () => {
    assert.deepEqual(
        sanitizeToolParametersForOpenAI({
            type: "object",
            propertyNames: { pattern: "^[a-z]+$" },
            properties: {
                data: {
                    type: "object",
                    propertyNames: { type: "string" },
                    patternProperties: { "^x-": { type: "string" } },
                    properties: {
                        value: { type: "string" },
                    },
                },
            },
        }),
        {
            type: "object",
            properties: {
                data: {
                    type: "object",
                    properties: {
                        value: { type: "string" },
                    },
                },
            },
        },
    );
});

test("compressMessages preserves tool-call boundary when keeping recent history", () => {
    const messages: ChatMessage[] = [
        { role: "system", content: "system" },
        { role: "user", content: "older user" },
        {
            role: "assistant",
            content: null,
            tool_calls: [
                { id: "call_old", type: "function", function: { name: "shell", arguments: "{}" } },
            ],
        },
        { role: "tool", tool_call_id: "call_old", name: "shell", content: "old result" },
        { role: "user", content: "new user" },
        {
            role: "assistant",
            content: null,
            tool_calls: [
                { id: "call_new", type: "function", function: { name: "read_file", arguments: "{}" } },
            ],
        },
        { role: "tool", tool_call_id: "call_new", name: "read_file", content: "new result" },
        { role: "assistant", content: "done" },
    ];

    const compressed = compressMessages(messages, "summarize", { keepRecent: 5 });

    assert.deepEqual(
        compressed.map((m) => m.role === "tool" ? `tool:${m.tool_call_id}` : m.role),
        ["system", "assistant", "tool:call_old", "user", "assistant", "tool:call_new", "assistant"],
    );
    assert.deepEqual(findToolHistoryIssues(compressed), []);
});

test("findToolHistoryIssues reports invalid dispatch windows without repairing them", () => {
    const messages: ChatMessage[] = [
        { role: "system", content: "system" },
        { role: "tool", tool_call_id: "call_old", name: "shell", content: "old result" },
        { role: "user", content: "new user" },
        {
            role: "assistant",
            content: null,
            tool_calls: [
                { id: "call_new", type: "function", function: { name: "read_file", arguments: "{}" } },
            ],
        },
    ];

    assert.deepEqual(
        findToolHistoryIssues(messages).map((issue) => issue.type),
        ["orphan_tool_message", "missing_tool_result"],
    );
});

test("windowMessages keeps tool results paired with the assistant call that produced them", () => {
    const messages: ChatMessage[] = [
        { role: "system", content: "system" },
        { role: "user", content: "older user" },
        {
            role: "assistant",
            content: null,
            tool_calls: [
                { id: "call_keep", type: "function", function: { name: "read_file", arguments: "{}" } },
            ],
        },
        { role: "tool", tool_call_id: "call_keep", name: "read_file", content: "result" },
        { role: "assistant", content: "done" },
    ];

    const windowed = windowMessages(messages, 2);

    assert.deepEqual(
        windowed.map((m) => m.role === "tool" ? `tool:${m.tool_call_id}` : m.role),
        ["system", "assistant", "tool:call_keep", "assistant"],
    );
    assert.deepEqual(findToolHistoryIssues(windowed), []);
});

test("request preflight compacts before an estimated context overflow", () => {
    const observed = assessContextWindow(339_000, 195_000, 0.8);
    assert.equal(observed.shouldCompact, true);
    assert.equal(observed.exceedsWindow, true);
    assert.ok(observed.usedRatio > 1.73);

    const disabled = assessContextWindow(339_000, 195_000, 0);
    assert.equal(disabled.shouldCompact, false);
    assert.equal(disabled.exceedsWindow, true);

    const source = readFileSync(resolve(__dirname, "../../src/adapters/openai/turnRunner.ts"), "utf8");
    const compactAt = source.indexOf("maybeAutoCompact(estimate.inputTokens)");
    const dispatchAt = source.indexOf("let res = await post(loginToken)");
    assert.ok(compactAt >= 0, "preflight estimate must feed the compactor");
    assert.ok(dispatchAt > compactAt, "compaction guard must run before the HTTP request");
    assert.match(source, /Request not sent: the local input estimate reaches or exceeds/);
});

test("materializeToolSafeHistory folds orphan tool results without mutating saved history", () => {
    const messages: ChatMessage[] = [
        { role: "system", content: "system" },
        { role: "tool", tool_call_id: "call_old", name: "shell", content: "old result" },
        { role: "user", content: "new user" },
    ];

    const materialized = materializeToolSafeHistory(messages, "developer");

    assert.equal(materialized.foldedOrphanTools, 1);
    assert.equal(materialized.foldedMissingToolCalls, 0);
    assert.equal(messages[1].role, "tool");
    assert.equal(materialized.messages[1].role, "developer");
    assert.match(String(materialized.messages[1].content), /Tool history compacted for dispatch/);
    assert.deepEqual(findToolHistoryIssues(materialized.messages), []);
});

test("materializeToolSafeHistory supplies a request-only result for missing tool calls", () => {
    const messages: ChatMessage[] = [
        { role: "system", content: "system" },
        { role: "user", content: "run tools" },
        {
            role: "assistant",
            content: null,
            tool_calls: [
                { id: "call_missing", type: "function", function: { name: "missing", arguments: "{}" } },
                { id: "call_present", type: "function", function: { name: "present", arguments: "{}" } },
            ],
        },
        { role: "tool", tool_call_id: "call_present", name: "present", content: "ok" },
    ];

    const materialized = materializeToolSafeHistory(messages);

    assert.equal(materialized.foldedOrphanTools, 0);
    assert.equal(materialized.foldedMissingToolCalls, 0);
    assert.equal(materialized.repairedMissingToolCalls, 1);
    assert.deepEqual(materialized.messages[2].tool_calls?.map((toolCall) => toolCall.id), ["call_missing", "call_present"]);
    assert.equal(materialized.messages[3].role, "tool");
    assert.equal(materialized.messages[3].tool_call_id, "call_missing");
    assert.match(String(materialized.messages[3].content), /was not executed/);
    assert.deepEqual(findToolHistoryIssues(materialized.messages), []);
});

test("repeated tool-call guard stops before an unmatched tool call is persisted", () => {
    const recent: string[] = [];
    const signature = 'read_file:{"path":"/repo/file.ts"}';

    for (let i = 1; i < REPEAT_TOOL_CALL_LIMIT; i++) {
        assert.equal(repeatedToolCallWithoutProgress(recent, signature), false, `call ${i} must remain executable`);
    }
    assert.equal(repeatedToolCallWithoutProgress(recent, signature), true);
    assert.deepEqual(recent, Array(REPEAT_TOOL_CALL_LIMIT).fill(signature));
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
