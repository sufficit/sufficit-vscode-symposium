#!/usr/bin/env node

const args = process.argv.slice(2);

if (args.includes("exec") && args.includes("--json")) {
    console.log(JSON.stringify({ type: "thread.started", thread_id: "fake-codex-session" }));
    console.log(
        JSON.stringify({
            type: "item.completed",
            item: { type: "agent_message", text: "fake codex reply" },
        }),
    );
    console.log(
        JSON.stringify({
            type: "turn.completed",
            usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 },
        }),
    );
} else if (args.includes("--input-format") && args.includes("stream-json")) {
    console.log(
        JSON.stringify({
            type: "system",
            subtype: "init",
            session_id: "fake-claude-session",
            model: "fake-model",
        }),
    );
    console.log(
        JSON.stringify({
            type: "assistant",
            message: { model: "fake-model", content: [{ type: "text", text: "fake claude reply" }] },
        }),
    );
    console.log(JSON.stringify({ type: "result", is_error: false, result: "ok" }));
} else if (args.includes("--output-format") && args.includes("json")) {
    console.log(
        JSON.stringify({ type: "assistant.message", data: { content: "fake copilot reply" } }),
    );
    console.log(JSON.stringify({ type: "result", sessionId: "fake-copilot-session" }));
} else if (args.includes("--version")) {
    console.log("fake-agent 1.0.0");
} else {
    console.error(`Unsupported fake-agent invocation: ${args.join(" ")}`);
    process.exitCode = 2;
}
