import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
    extractUserPromptText,
    extractWorkspaceCwd,
    GeminiAdapter,
    listGeminiSessions,
    parseGeminiTranscriptLine,
    readGeminiHistory,
    readGeminiMeta,
} from "../adapters/gemini";
import { readSession } from "../sessionReader";

interface Fixture {
    home: string;
    roots: { gemini: string; antigravity: string };
    geminiFile: string;
    antigravityFile: string;
}

function createFixture(): Fixture {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "symposium-gemini-"));
    const roots = {
        gemini: path.join(home, ".gemini", "history"),
        antigravity: path.join(home, ".gemini", "antigravity-ide", "brain"),
    };
    const geminiFile = path.join(roots.gemini, "gemini-session.jsonl");
    const antigravityFile = path.join(
        roots.antigravity,
        "antigravity-session",
        ".system_generated",
        "logs",
        "transcript.jsonl",
    );
    fs.mkdirSync(path.dirname(geminiFile), { recursive: true });
    fs.mkdirSync(path.dirname(antigravityFile), { recursive: true });
    fs.writeFileSync(
        geminiFile,
        [
            "{invalid-json",
            JSON.stringify({
                source: "USER_EXPLICIT",
                type: "USER_INPUT",
                timestamp: "2026-08-28T10:00:00.000Z",
                content: "<USER_REQUEST>Gemini request</USER_REQUEST>\n[URI] -> /work/gemini",
            }),
            JSON.stringify({
                source: "MODEL",
                type: "MODEL_RESPONSE",
                created_at: "2026-08-28T10:00:01.000Z",
                metadata: { model: "gemini-2.5-pro" },
                content: [{ text: "Gemini response" }],
            }),
            JSON.stringify({ source: "TOOL", type: "TOOL_RESULT", content: "hidden" }),
        ].join("\n"),
    );
    fs.writeFileSync(
        antigravityFile,
        [
            JSON.stringify({
                source: "USER_EXPLICIT",
                type: "USER_INPUT",
                createdAt: 1_777_777_777_000,
                content:
                    "<USER_REQUEST>Antigravity request</USER_REQUEST>\nActive Document: C:\\repo\\src\\file.ts (TYPESCRIPT)",
            }),
            JSON.stringify({
                source: "MODEL",
                type: "PLANNER_RESPONSE",
                timestamp: "2026-08-29T10:00:00.000Z",
                model_name: "gemini-3-pro",
                content: "Antigravity response",
            }),
        ].join("\n"),
    );
    fs.utimesSync(geminiFile, new Date(1_700_000_000_000), new Date(1_700_000_000_000));
    fs.utimesSync(antigravityFile, new Date(1_800_000_000_000), new Date(1_800_000_000_000));
    return { home, roots, geminiFile, antigravityFile };
}

test("Gemini prompt and workspace extraction handles wrapped and cross-platform input", () => {
    assert.equal(
        extractUserPromptText(
            "<USER_REQUEST>\nFix the parser\n</USER_REQUEST>\n<ADDITIONAL_METADATA>x</ADDITIONAL_METADATA>",
        ),
        "Fix the parser",
    );
    assert.equal(extractUserPromptText("plain prompt"), "plain prompt");
    assert.equal(extractUserPromptText(""), "");
    assert.equal(extractWorkspaceCwd("[URI] -> /home/user/workspace"), "/home/user/workspace");
    assert.equal(
        extractWorkspaceCwd("Active Document: /home/user/workspace/src/index.ts (TYPESCRIPT)"),
        "/home/user/workspace/src",
    );
    assert.equal(
        extractWorkspaceCwd("Active Document: C:\\repo\\src\\index.ts (TYPESCRIPT)"),
        "C:\\repo\\src",
    );
    assert.equal(extractWorkspaceCwd("no path"), undefined);
});

test("Gemini transcript parsing preserves role, model and original timestamps", async () => {
    const fixture = createFixture();
    try {
        const meta = await readGeminiMeta(fixture.antigravityFile);
        assert.deepEqual(meta, {
            title: "Antigravity request",
            cwd: "C:\\repo\\src",
            model: "gemini-3-pro",
        });
        const history = await readGeminiHistory(fixture.geminiFile);
        assert.equal(history.length, 2);
        assert.deepEqual(history[0], {
            role: "user",
            text: "Gemini request",
            ts: Date.parse("2026-08-28T10:00:00.000Z"),
        });
        assert.equal(history[1].role, "assistant");
        assert.equal(history[1].model, "gemini-2.5-pro");
        assert.equal(history[1].modelLabel, "gemini-2.5-pro");
        assert.equal(history[1].text, "Gemini response");
        assert.deepEqual(parseGeminiTranscriptLine(""), []);
        assert.deepEqual(parseGeminiTranscriptLine("{bad"), []);
        assert.deepEqual(
            parseGeminiTranscriptLine(JSON.stringify({ type: "TOOL_RESULT", content: "x" })),
            [],
        );
        assert.deepEqual(await readGeminiMeta(path.join(fixture.home, "missing.jsonl")), {});
    } finally {
        fs.rmSync(fixture.home, { recursive: true, force: true });
    }
});

test("Gemini discovery separates sources, sorts, limits and reuses unchanged metadata", async () => {
    const fixture = createFixture();
    try {
        fs.mkdirSync(path.join(fixture.roots.antigravity, "missing-transcript"));
        fs.mkdirSync(path.join(fixture.roots.gemini, "ignored.jsonl"));
        fs.writeFileSync(path.join(fixture.roots.gemini, "ignored.txt"), "ignored");
        const sessions = await listGeminiSessions([], { roots: fixture.roots });
        assert.equal(sessions.length, 2);
        assert.equal(sessions[0].backend, "antigravity");
        assert.equal(sessions[0].sessionId, "antigravity-session");
        assert.equal(sessions[0].continuationBlockedReason, "external-readonly");
        assert.equal(sessions[1].backend, "gemini");
        assert.equal(sessions[1].model, "gemini-2.5-pro");

        const cached = sessions.map((session) =>
            session.backend === "gemini" ? { ...session, title: "cached title" } : session,
        );
        const incremental = await listGeminiSessions(cached, {
            roots: fixture.roots,
            sources: ["gemini"],
        });
        assert.equal(incremental[0].title, "cached title");

        const limited = await listGeminiSessions([], { roots: fixture.roots, limit: 1 });
        assert.equal(limited.length, 1);
        assert.equal(limited[0].backend, "antigravity");
        const absent = await listGeminiSessions([], {
            roots: {
                gemini: path.join(fixture.home, "absent-gemini"),
                antigravity: path.join(fixture.home, "absent-antigravity"),
            },
        });
        assert.deepEqual(absent, []);
    } finally {
        fs.rmSync(fixture.home, { recursive: true, force: true });
    }
});

test("Gemini adapters expose read-only history without entering creation flows", async () => {
    const fixture = createFixture();
    try {
        const gemini = new GeminiAdapter("gemini", fixture.roots);
        const antigravity = new GeminiAdapter("antigravity", fixture.roots);
        assert.equal(gemini.canStartSessions, false);
        assert.equal(gemini.displayName, "Gemini");
        assert.equal(antigravity.displayName, "Antigravity");
        assert.deepEqual(await gemini.available(), {
            ok: true,
            version: "history (read-only)",
        });
        assert.equal((await gemini.listSessions()).length, 1);
        assert.equal((await antigravity.listSessionsIncremental([]))[0].backend, "antigravity");
        assert.equal(
            (await gemini.history({ backend: "gemini", sessionId: "x", title: "x" })).messages
                .length,
            0,
        );
        const history = await gemini.history({
            backend: "gemini",
            sessionId: "gemini-session",
            title: "Gemini request",
            transcriptPath: fixture.geminiFile,
        });
        assert.equal(history.messages.length, 2);
        assert.throws(() => gemini.start({ cwd: fixture.home }), /available as read-only history/);
        const usage = await antigravity.usage.read();
        assert.equal(usage.state, "unavailable");
        assert.match(usage.message ?? "", /do not expose account usage limits/);

        const invalidRoots = {
            gemini: path.join(fixture.home, "not-a-directory"),
            antigravity: path.join(fixture.home, "missing"),
        };
        fs.writeFileSync(invalidRoots.gemini, "file");
        assert.equal((await new GeminiAdapter("gemini", invalidRoots).available()).ok, false);
        assert.equal((await new GeminiAdapter("antigravity", invalidRoots).available()).ok, false);
    } finally {
        fs.rmSync(fixture.home, { recursive: true, force: true });
    }
});

test("cross-adapter session reader resolves exact Gemini and Antigravity paths", () => {
    const fixture = createFixture();
    try {
        const gemini = readSession("gemini-session", { homeDir: fixture.home });
        assert.equal(gemini.source, "cli");
        assert.equal(gemini.backend, "gemini");
        assert.equal(gemini.count, 2);
        assert.equal(gemini.messages[0].text, "Gemini request");
        assert.equal(gemini.messages[0].at, "2026-08-28T10:00:00.000Z");

        const antigravity = readSession("antigravity-session", { homeDir: fixture.home });
        assert.equal(antigravity.backend, "antigravity");
        assert.equal(antigravity.messages[1].text, "Antigravity response");
        assert.equal(antigravity.messages[0].at, new Date(1_777_777_777_000).toISOString());

        const missing = readSession("missing-session", { homeDir: fixture.home });
        assert.equal(missing.source, "none");
        assert.equal(missing.count, 0);
    } finally {
        fs.rmSync(fixture.home, { recursive: true, force: true });
    }
});
