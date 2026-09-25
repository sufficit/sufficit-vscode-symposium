import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { GeniusAdapter } from "../adapters/genius/adapter";
import { GeniusEventParser } from "../adapters/genius/eventParser";
import { resolveGeniusExecutable } from "../adapters/genius/executable";
import type { AgentEvent, AgentSession } from "../adapters/types";

const fakeCli = path.resolve(__dirname, "../../test/fixtures/fake-genius-cli.cjs");
const sessionId = "11111111-2222-4333-8444-555555555555";

test("Genius resolves the native Windows CLI behind the installed wrapper", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "symposium-genius-windows-"));
    try {
        const install = path.join(root, "Programs", "SufficitAIGenius");
        const installed = path.join(install, "service", "Sufficit.AI.Genius.Service.exe");
        fs.mkdirSync(path.dirname(installed), { recursive: true });
        fs.writeFileSync(installed, "");
        assert.equal(resolveGeniusExecutable("genius", "win32", { LOCALAPPDATA: root }), installed);
        assert.equal(resolveGeniusExecutable(path.join(install, "genius.cmd"), "win32"), installed);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

function collectTurn(
    session: AgentSession,
    prompt: string,
    images?: string[],
): Promise<AgentEvent[]> {
    return new Promise((resolve, reject) => {
        const events: AgentEvent[] = [];
        const timer = setTimeout(() => reject(new Error("Genius turn timed out")), 5000);
        const onEvent = (event: AgentEvent) => {
            events.push(event);
            if (event.kind === "turn-end") {
                clearTimeout(timer);
                session.off("event", onEvent);
                resolve(events);
            }
        };
        session.on("event", onEvent);
        session.send(prompt, images, undefined, "intent-1");
    });
}

test("Genius parser streams markdown once and keeps reasoning and tools distinct", () => {
    const events: AgentEvent[] = [];
    const ids: string[] = [];
    const parser = new GeniusEventParser({
        session: (id) => ids.push(id),
        emit: (event) => events.push(event),
    });
    const frame = (actionType: string, action: object) =>
        JSON.stringify({
            type: "event",
            schemaVersion: 1,
            actionType,
            action,
        });
    parser.handleLine(JSON.stringify({ type: "session", schemaVersion: 1, sessionId }));
    parser.handleLine(frame("chat/responsePart", { partId: "md", kind: "Markdown" }));
    parser.handleLine(frame("chat/responsePart", { partId: "tool", kind: "ToolCall" }));
    parser.handleLine(frame("chat/delta", { partId: "tool", content: 'shell({"cmd":"pwd"})' }));
    parser.handleLine(frame("chat/delta", { partId: "md", content: "Answer" }));
    parser.handleLine(frame("chat/reasoning", { partId: "rz", content: "Thinking" }));
    parser.handleLine(frame("chat/delta", { partId: "tool", content: " → done" }));
    parser.handleLine(
        frame("chat/usage", { usage: { inputTokens: 7, outputTokens: 3, cachedTokens: 2 } }),
    );
    parser.handleLine(
        JSON.stringify({
            type: "result",
            schemaVersion: 1,
            sessionId,
            status: "completed",
            answer: "Answer",
            error: null,
        }),
    );

    assert.deepEqual(ids, [sessionId]);
    assert.deepEqual(
        events.filter((event) => event.kind === "text"),
        [{ kind: "text", text: "Answer" }],
    );
    assert.ok(events.some((event) => event.kind === "thinking" && event.text === "Thinking"));
    assert.ok(events.some((event) => event.kind === "tool-start" && event.toolName === "shell"));
    assert.ok(events.some((event) => event.kind === "tool-end" && event.result === "done"));
    assert.ok(events.some((event) => event.kind === "usage" && event.inputTokens === 7));
});

test("Genius adapter discovers sessions and resumes context through the CLI UUID", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "symposium-genius-test-"));
    const trace = path.join(root, "calls.jsonl");
    const adapter = new GeniusAdapter(() => ({
        executable: fakeCli,
        model: "requested-preset",
        env: { FAKE_GENIUS_TRACE: trace },
    }));
    try {
        assert.deepEqual(await adapter.available(), { ok: true, version: "0.125.2" });
        assert.equal(adapter.usage.backend, "genius");
        const listed = await adapter.listSessions();
        assert.equal(listed.length, 1);
        assert.equal(listed[0].sessionId, sessionId);
        assert.equal(listed[0].model, "test-preset");

        const session = adapter.start({ cwd: root });
        try {
            const first = await collectTurn(session, "First prompt");
            assert.equal(first[0].kind, "turn-start");
            assert.ok(
                first.some((event) => event.kind === "session" && event.sessionId === sessionId),
            );
            assert.deepEqual(
                first.filter((event) => event.kind === "text"),
                [{ kind: "text", text: "Hello from Genius" }],
            );
            assert.ok(first.some((event) => event.kind === "usage" && event.cacheRead === 2));
            assert.equal(session.sessionId, sessionId);
            assert.equal((await collectTurn(session, "Second prompt")).at(-1)?.kind, "turn-end");
        } finally {
            session.dispose();
        }

        const calls = fs
            .readFileSync(trace, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as { args: string[]; prompt: string });
        assert.deepEqual(
            calls.map((call) => call.prompt),
            ["First prompt", "Second prompt"],
        );
        assert.deepEqual(calls[0].args.slice(0, 3), ["exec", "--stdin", "--json"]);
        assert.ok(!calls[0].args.includes("--resume"));
        assert.ok(calls[0].args.includes("requested-preset"));
        assert.deepEqual(calls[1].args.slice(3, 5), ["--resume", sessionId]);

        const reopened = adapter.start({ cwd: root, resumeSessionId: sessionId });
        try {
            await collectTurn(reopened, "Reopened prompt");
        } finally {
            reopened.dispose();
        }
        const last = JSON.parse(fs.readFileSync(trace, "utf8").trim().split("\n").at(-1)!) as {
            args: string[];
        };
        assert.ok(last.args.includes("--resume"));
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("Genius passes a fresh Symposium bearer only to the current CLI child", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "symposium-genius-auth-"));
    const trace = path.join(root, "calls.jsonl");
    let nextToken = 0;
    const adapter = new GeniusAdapter(() => ({
        executable: fakeCli,
        model: "",
        env: { FAKE_GENIUS_TRACE: trace },
        tokenProvider: () => Promise.resolve(`delegated-${++nextToken}`),
    }));
    const session = adapter.start({ cwd: root });
    try {
        await collectTurn(session, "First");
        await collectTurn(session, "Second");
        const calls = fs
            .readFileSync(trace, "utf8")
            .trim()
            .split("\n")
            .map(
                (line) =>
                    JSON.parse(line) as {
                        args: string[];
                        prompt: string;
                        authToken: string | null;
                    },
            );
        assert.deepEqual(
            calls.map((call) => call.authToken),
            ["delegated-1", "delegated-2"],
        );
        assert.ok(calls.every((call) => !call.args.some((arg) => arg.includes("delegated-"))));
    } finally {
        session.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("Genius does not start a CLI child after cancellation during authentication", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "symposium-genius-cancel-auth-"));
    const trace = path.join(root, "calls.jsonl");
    let release!: (token: string) => void;
    const adapter = new GeniusAdapter(() => ({
        executable: fakeCli,
        model: "",
        env: { FAKE_GENIUS_TRACE: trace },
        tokenProvider: () =>
            new Promise<string>((resolve) => {
                release = resolve;
            }),
    }));
    const session = adapter.start({ cwd: root });
    try {
        const ended = new Promise<void>((resolve) => {
            session.on("event", (event: AgentEvent) => {
                if (event.kind === "turn-end") resolve();
            });
        });
        session.send("Cancelled");
        session.cancel();
        await ended;
        release("late-token");
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.equal(fs.existsSync(trace), false);
    } finally {
        session.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("Genius reports token lookup failures without starting the CLI", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "symposium-genius-auth-error-"));
    const trace = path.join(root, "calls.jsonl");
    const adapter = new GeniusAdapter(() => ({
        executable: fakeCli,
        model: "",
        env: { FAKE_GENIUS_TRACE: trace },
        tokenProvider: () => Promise.reject(new Error("identity unavailable")),
    }));
    const session = adapter.start({ cwd: root });
    try {
        const events = await collectTurn(session, "Hello");
        assert.ok(
            events.some(
                (event) => event.kind === "error" && event.message.includes("identity unavailable"),
            ),
        );
        assert.equal(fs.existsSync(trace), false);
    } finally {
        session.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("Genius cancellation ends the turn without reporting a CLI failure", async () => {
    const adapter = new GeniusAdapter(() => ({
        executable: fakeCli,
        model: "",
        env: { FAKE_GENIUS_MODE: "wait" },
    }));
    const session = adapter.start({ cwd: process.cwd() });
    try {
        const events: AgentEvent[] = [];
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(
                () => reject(new Error("Genius cancellation timed out")),
                5000,
            );
            session.on("event", (event: AgentEvent) => {
                events.push(event);
                if (event.kind === "session") session.cancel();
                if (event.kind === "turn-end") {
                    clearTimeout(timer);
                    resolve();
                }
            });
            session.send("Wait");
        });
        assert.equal(events.at(-1)?.kind, "turn-end");
        assert.equal(
            events.some((event) => event.kind === "error"),
            false,
        );
    } finally {
        session.dispose();
    }
});

test("Genius reports deleted sessions and unsupported attachments explicitly", async () => {
    const adapter = new GeniusAdapter(() => ({
        executable: fakeCli,
        model: "",
        env: { FAKE_GENIUS_MODE: "missing" },
    }));
    const session = adapter.start({ cwd: process.cwd(), resumeSessionId: sessionId });
    try {
        const missing = await collectTurn(session, "Hello");
        assert.ok(
            missing.some(
                (event) => event.kind === "error" && event.message.includes("start a new chat"),
            ),
        );
        assert.equal(session.sessionId, sessionId);
        const image = await collectTurn(session, "Look", ["/tmp/image.png"]);
        assert.ok(
            image.some(
                (event) => event.kind === "error" && event.message.includes("image attachments"),
            ),
        );
    } finally {
        session.dispose();
    }
});

test("Genius availability reports missing executables and unsupported CLI protocols", async () => {
    const missing = new GeniusAdapter(() => ({
        executable: path.join(os.tmpdir(), "missing-genius-executable"),
        model: "",
    }));
    const absent = await missing.available();
    assert.equal(absent.ok, false);
    assert.match(absent.error ?? "", /ENOENT/);

    for (const mode of ["invalid_json", "old_protocol"]) {
        const adapter = new GeniusAdapter(() => ({
            executable: fakeCli,
            model: "",
            env: { FAKE_GENIUS_MODE: mode },
        }));
        const status = await adapter.available();
        assert.equal(status.ok, false);
        assert.match(status.error ?? "", /invalid JSON|protocol version/);
    }
});

test("Genius session discovery filters malformed records and preserves cached sessions on CLI errors", async () => {
    const mixed = new GeniusAdapter(() => ({
        executable: fakeCli,
        model: "",
        env: { FAKE_GENIUS_MODE: "mixed_sessions" },
    }));
    const listed = await mixed.listSessions();
    assert.deepEqual(
        listed.map((session) => session.sessionId),
        [sessionId],
    );
    assert.equal(listed[0].title, "Genius session");
    assert.equal(listed[0].model, undefined);

    const cached = [{ ...listed[0], title: "Old title", updatedAt: new Date("2026-09-25") }];
    const refreshed = await mixed.listSessionsIncremental(cached);
    assert.equal(refreshed[0].title, "Genius session");
    assert.equal(refreshed[0].updatedAt, cached[0].updatedAt);

    const invalid = new GeniusAdapter(() => ({
        executable: fakeCli,
        model: "",
        env: { FAKE_GENIUS_MODE: "invalid_sessions" },
    }));
    await assert.rejects(invalid.listSessions(), /invalid sessions response/);
    assert.deepEqual(await invalid.listSessionsIncremental(cached), cached);
});
