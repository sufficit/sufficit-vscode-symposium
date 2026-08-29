import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
    GeminiAdapter,
    listGeminiSessions,
    readGeminiMeta,
    extractUserPromptText,
    extractWorkspaceCwd,
} from "../adapters/gemini";
import { readSession } from "../sessionReader";

test("extractUserPromptText extracts body from USER_REQUEST tags", () => {
    const raw =
        "<USER_REQUEST>\nFix the bug in the parser\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nsome metadata\n</ADDITIONAL_METADATA>";
    assert.equal(extractUserPromptText(raw), "Fix the bug in the parser");
    assert.equal(extractUserPromptText(""), "");
});

test("extractUserPromptText falls back to raw content when no tags exist", () => {
    const raw = "Simple prompt without tags";
    assert.equal(extractUserPromptText(raw), "Simple prompt without tags");
});

test("extractWorkspaceCwd extracts URI and active document paths", () => {
    const info =
        "<user_information>\n[URI] -> /home/user/workspace\nActive Document: /home/user/workspace/src/index.ts\n</user_information>";
    assert.equal(extractWorkspaceCwd(info), "/home/user/workspace");

    const onlyDoc = "Active Document: /home/user/workspace/src/index.ts (TYPESCRIPT)";
    assert.equal(extractWorkspaceCwd(onlyDoc), "/home/user/workspace/src");
    assert.equal(extractWorkspaceCwd(""), undefined);
    assert.equal(extractWorkspaceCwd("no path here"), undefined);
});

test("readGeminiMeta reads title, cwd and model from JSONL transcript", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-test-"));
    const transcriptFile = path.join(tmpDir, "transcript.jsonl");

    const lines = [
        JSON.stringify({
            step_index: 0,
            source: "USER_EXPLICIT",
            type: "USER_INPUT",
            content:
                "<USER_REQUEST>\nImplement Antigravity Filter\n</USER_REQUEST>\nActive Document: /home/test/project/file.ts\n",
        }),
        JSON.stringify({
            step_index: 1,
            source: "MODEL",
            type: "PLANNER_RESPONSE",
            model: "gemini-2.5-pro",
            content: "I will implement the filter now.",
        }),
    ];

    fs.writeFileSync(transcriptFile, lines.join("\n"));

    const meta = await readGeminiMeta(transcriptFile);
    assert.equal(meta.title, "Implement Antigravity Filter");
    assert.equal(meta.cwd, "/home/test/project");
    assert.equal(meta.model, "gemini-2.5-pro");

    const unreadable = await readGeminiMeta("/tmp/non-existent-gemini-transcript.jsonl");
    assert.deepEqual(unreadable, {});

    fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("GeminiAdapter reports backend, commands, availability and session lifecycle", async () => {
    const adapter = new GeminiAdapter();
    assert.equal(adapter.backend, "gemini");
    assert.equal(adapter.displayName, "Gemini");
    const avail = await adapter.available();
    assert.equal(typeof avail.ok, "boolean");
    assert.ok(adapter.models().includes("gemini-2.5-pro"));

    const cmds = await adapter.commands();
    assert.deepEqual(cmds, []);
    assert.equal(adapter.usage.backend, "gemini");
    assert.equal(adapter.usage.displayName, "Gemini");

    const session = adapter.start({ cwd: "/home/user/workspace", resumeSessionId: "session-123" });
    assert.equal(session.backend, "gemini");
    assert.equal(session.sessionId, "session-123");

    let eventFired = false;
    session.on("event", (ev) => {
        if (ev.kind === "text") {
            eventFired = true;
        }
    });
    session.send("Hello Gemini");
    assert.equal(eventFired, true);

    session.cancel();
    session.dispose();
});

test("listGeminiSessions scans sessions and uses cached items", async () => {
    const sessions = await listGeminiSessions([]);
    assert.ok(Array.isArray(sessions));

    const incremental = await listGeminiSessions(sessions);
    assert.ok(Array.isArray(incremental));
    assert.equal(incremental.length, sessions.length);

    const adapter = new GeminiAdapter();
    const adapterSessions = await adapter.listSessions();
    assert.ok(Array.isArray(adapterSessions));

    const adapterIncremental = await adapter.listSessionsIncremental(adapterSessions);
    assert.ok(Array.isArray(adapterIncremental));
});

test("readSession returns none for non-existent session ID and reads existing", () => {
    const dump = readSession("non-existent-session-00000000");
    assert.equal(dump.source, "none");
    assert.equal(dump.count, 0);

    const currentSession = readSession("2bb448d0-3917-46fc-83df-3cc1a15f768b");
    if (currentSession.source !== "none") {
        assert.equal(currentSession.backend, "gemini");
        assert.ok(currentSession.count > 0);
    }
});
