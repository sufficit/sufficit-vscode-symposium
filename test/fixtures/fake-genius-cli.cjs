#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const args = process.argv.slice(2);
const id = "11111111-2222-4333-8444-555555555555";
const write = (record) => process.stdout.write(`${JSON.stringify(record)}\n`);
const envelope = (type, status, data) => ({ schemaVersion: 1, type, status, data, error: null });

if (args.includes("--version")) {
    if (process.env.FAKE_GENIUS_MODE === "invalid_json") {
        process.stdout.write("not JSON\n");
    } else if (process.env.FAKE_GENIUS_MODE === "old_protocol") {
        write({ ...envelope("version", "ok", { version: "0.1" }), schemaVersion: 2 });
    } else {
        write(envelope("version", "ok", { version: "0.125.2" }));
    }
} else if (args[0] === "sessions") {
    if (process.env.FAKE_GENIUS_MODE === "invalid_sessions") {
        write(envelope("sessions", "ok", { sessions: "invalid" }));
    } else if (process.env.FAKE_GENIUS_MODE === "mixed_sessions") {
        write(envelope("sessions", "ok", { sessions: [null, { sessionId: "invalid" }, { sessionId: id }] }));
    } else {
        write(envelope("sessions", "ok", {
            sessions: [{ type: "session", schemaVersion: 1, sessionId: id, title: "Genius test", presetId: "test-preset" }],
        }));
    }
} else if (args[0] === "exec") {
    let prompt = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { prompt += chunk; });
    process.stdin.on("end", () => {
        if (process.env.FAKE_GENIUS_TRACE) {
            fs.appendFileSync(process.env.FAKE_GENIUS_TRACE, `${JSON.stringify({ args, prompt })}\n`);
        }
        if (process.env.FAKE_GENIUS_MODE === "missing") {
            write(envelope("error", "failed", {
                code: "session_not_found", sessionId: id, command: "exec", exitCode: 1,
            }));
            process.exitCode = 1;
            return;
        }
        write({ type: "session", schemaVersion: 1, sessionId: id, presetId: "test-preset" });
        if (process.env.FAKE_GENIUS_MODE === "wait") {
            process.on("SIGINT", () => process.exit(130));
            setInterval(() => undefined, 1000);
            return;
        }
        write({ type: "event", schemaVersion: 1, sessionId: id, seq: 1,
            actionType: "chat/responsePart", action: { partId: "p1", kind: "Markdown" } });
        write({ type: "event", schemaVersion: 1, sessionId: id, seq: 2,
            actionType: "chat/delta", action: { partId: "p1", content: "Hello from Genius" } });
        write({ type: "event", schemaVersion: 1, sessionId: id, seq: 3,
            actionType: "chat/usage", action: { usage: { inputTokens: 9, outputTokens: 3, cachedTokens: 2 } } });
        write({ type: "result", schemaVersion: 1, sessionId: id,
            status: "completed", answer: "Hello from Genius", error: null });
    });
} else {
    process.stderr.write("Unexpected Genius command\n");
    process.exitCode = 2;
}
