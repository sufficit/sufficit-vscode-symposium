import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { GeniusAdapter } from "../adapters/genius/adapter";
import type { AgentEvent, AgentSession } from "../adapters/types";

const fakeCli = path.resolve(__dirname, "../../test/fixtures/fake-genius-cli.cjs");
const sessionId = "11111111-2222-4333-8444-555555555555";

function collectTurn(session: AgentSession, prompt: string): Promise<AgentEvent[]> {
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
        session.send(prompt);
    });
}

test("Genius keeps a newly selected preset after resumed turns report the old session preset", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "symposium-genius-model-switch-"));
    const trace = path.join(root, "calls.jsonl");
    const adapter = new GeniusAdapter(() => ({
        executable: fakeCli,
        model: "",
        env: { FAKE_GENIUS_TRACE: trace },
    }));
    const session = adapter.start({ cwd: root });
    try {
        await collectTurn(session, "First prompt");
        assert.equal(session.getModel?.(), "test-preset");

        session.setModel?.("selected-preset");
        await collectTurn(session, "Second prompt");
        assert.equal(session.getModel?.(), "selected-preset");
        await collectTurn(session, "Third prompt");

        const calls = fs
            .readFileSync(trace, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as { args: string[]; prompt: string });
        assert.equal(calls[0].args.includes("--preset"), false);
        assert.deepEqual(
            calls.slice(1).map((call) => call.args[call.args.indexOf("--preset") + 1]),
            ["selected-preset", "selected-preset"],
        );
        assert.deepEqual(
            calls.slice(1).map((call) => call.args.slice(3, 5)),
            [
                ["--resume", sessionId],
                ["--resume", sessionId],
            ],
        );
    } finally {
        session.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("Genius preserves a model switch made while a prequeued turn is still launching", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "symposium-genius-prequeue-race-"));
    const trace = path.join(root, "calls.jsonl");
    let releaseToken!: () => void;
    const tokenGate = new Promise<void>((resolve) => {
        releaseToken = resolve;
    });
    const adapter = new GeniusAdapter(() => ({
        executable: fakeCli,
        model: "",
        env: { FAKE_GENIUS_MODE: "queued", FAKE_GENIUS_TRACE: trace },
        // Defers the CLI spawn so setModel() below lands while launchExec is
        // still in flight, reproducing the late "session" record race.
        tokenProvider: async () => {
            await tokenGate;
            return null;
        },
    }));
    const session = adapter.start({ cwd: root, resumeSessionId: sessionId });
    try {
        session.prequeue?.("Queued prompt", [], "queue-1");
        session.setModel?.("selected-preset");
        releaseToken();

        const events = await new Promise<AgentEvent[]>((resolve, reject) => {
            const collected: AgentEvent[] = [];
            const timeout = setTimeout(() => reject(new Error("Queued turn timed out")), 5000);
            session.on("event", (event: AgentEvent) => {
                collected.push(event);
                if (event.kind === "turn-end") {
                    clearTimeout(timeout);
                    resolve(collected);
                }
            });
            session.send("Queued prompt", [], [], "intent-queue", undefined, "queue-1");
        });
        assert.equal(
            events.some((event) => event.kind === "error"),
            false,
        );
        assert.equal(session.getModel?.(), "selected-preset");

        await collectTurn(session, "Next prompt");

        const calls = fs
            .readFileSync(trace, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as { args: string[] });
        assert.equal(calls[0].args.includes("--preset"), false);
        assert.equal(calls[1].args[calls[1].args.indexOf("--preset") + 1], "selected-preset");
    } finally {
        session.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    }
});
