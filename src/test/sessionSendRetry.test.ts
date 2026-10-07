import assert from "node:assert/strict";
import test from "node:test";
import { appendUserTurn } from "../adapters/openai/sessionSend";
import { createRunnerDeps } from "./openaiRunnerFixture";
import type { ChatMessage } from "../adapters/openai/types";

for (const multimodal of [false, true]) {
    test(`retry after tools preserves the original history (multimodal=${multimodal})`, () => {
        const deps = createRunnerDeps(() => undefined);
        const messages: ChatMessage[] = [
            {
                role: "user",
                content: multimodal
                    ? [
                          { type: "text", text: "prompt" },
                          { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } },
                      ]
                    : "prompt",
            },
            {
                role: "assistant",
                content: null,
                tool_calls: [
                    {
                        id: "saved",
                        type: "function",
                        function: { name: "write_file", arguments: "{}" },
                    },
                ],
            },
            { role: "tool", tool_call_id: "saved", name: "write_file", content: "written" },
        ];
        const before = structuredClone(messages);
        const ledgerRows: unknown[] = [];
        const appended = appendUserTurn(
            {
                cfg: deps.cfg,
                sessionId: deps.sessionId,
                messages,
                turnSeq: 1,
                led: (...args) => ledgerRows.push(args),
            },
            { text: "prompt", retry: true, preamble: ["one-shot instructions"] },
        );
        assert.equal(appended, false);
        assert.deepEqual(messages, before);
        assert.deepEqual(ledgerRows, []);
    });
}

test("an edited retry remains a new user instruction", () => {
    const deps = createRunnerDeps(() => undefined);
    const messages = deps.getMessages();
    appendUserTurn(
        { cfg: deps.cfg, sessionId: deps.sessionId, messages, turnSeq: 1, led: () => undefined },
        { text: "new request", retry: true },
    );
    assert.equal(messages.at(-1)?.content, "new request");
    assert.equal(messages.filter((m) => m.role === "user").length, 2);
});
