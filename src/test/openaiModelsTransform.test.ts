import test from "node:test";
import assert from "node:assert/strict";
import {
    getDiscoveredContext,
    getDiscoveredLabels,
    getDiscoveredModels,
    hasDiscoveredModels,
    modelContextLength,
    setDiscovered,
} from "../adapters/openai/models";
import { contentText, toResponsesInput } from "../adapters/openai/transform";
import type { ChatMessage } from "../adapters/openai/types";

test("OpenAI model discovery keeps ids, labels and context isolated by base URL", () => {
    const baseUrl = `https://models-${Date.now()}.invalid`;
    assert.equal(hasDiscoveredModels(baseUrl), false);
    assert.equal(getDiscoveredModels(baseUrl), undefined);

    setDiscovered(baseUrl, ["luna"], { luna: "Luna" }, { luna: 200_000 });

    assert.equal(hasDiscoveredModels(baseUrl), true);
    assert.deepEqual(getDiscoveredModels(baseUrl), ["luna"]);
    assert.deepEqual(getDiscoveredLabels(baseUrl), { luna: "Luna" });
    assert.deepEqual(getDiscoveredContext(baseUrl), { luna: 200_000 });
    assert.equal(modelContextLength({ limits: { context_window: 128_000 } }), 128_000);
    assert.equal(modelContextLength({ context_length: "64000" }), 64_000);
    assert.equal(modelContextLength({ context_length: 0 }), undefined);
    assert.equal(modelContextLength(null), undefined);
});

test("Responses input conversion preserves text, vision and tool-call semantics", () => {
    assert.equal(contentText("plain"), "plain");
    assert.equal(
        contentText([
            { type: "text", text: "first" },
            { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } },
            { type: "text", text: "second" },
        ]),
        "first\nsecond",
    );
    assert.equal(contentText(null), "");

    const messages: ChatMessage[] = [
        { role: "user", content: "hello" },
        {
            role: "user",
            content: [
                { type: "text", text: "inspect" },
                { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } },
            ],
        },
        {
            role: "assistant",
            content: "calling",
            tool_calls: [
                {
                    id: "call-1",
                    type: "function",
                    function: { name: "read_file", arguments: '{"path":"a.ts"}' },
                },
            ],
        },
        { role: "tool", tool_call_id: "call-1", content: "file contents" },
    ];

    assert.deepEqual(toResponsesInput(messages), [
        { role: "user", content: "hello" },
        {
            role: "user",
            content: [
                { type: "input_text", text: "inspect" },
                { type: "input_image", image_url: "data:image/png;base64,AA==" },
            ],
        },
        { role: "assistant", content: "calling" },
        {
            type: "function_call",
            call_id: "call-1",
            name: "read_file",
            arguments: '{"path":"a.ts"}',
        },
        { type: "function_call_output", call_id: "call-1", output: "file contents" },
    ]);
});
