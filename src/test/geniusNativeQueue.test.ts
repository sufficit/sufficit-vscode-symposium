import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { GeniusAdapter } from "../adapters/genius/adapter";
import type { AgentEvent } from "../adapters/types";

const fakeCli = path.resolve(__dirname, "../../test/fixtures/fake-genius-cli.cjs");
const sessionId = "11111111-2222-4333-8444-555555555555";

test("Genius prequeues once and replays the same native turn when Symposium dispatches", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "symposium-genius-queue-"));
    const trace = path.join(root, "calls.jsonl");
    const adapter = new GeniusAdapter(() => ({
        executable: fakeCli,
        model: "test-preset",
        env: { FAKE_GENIUS_MODE: "queued", FAKE_GENIUS_TRACE: trace },
        tokenProvider: () => Promise.resolve(null),
    }));
    const session = adapter.start({ cwd: root, resumeSessionId: sessionId });
    try {
        session.prequeue?.("Queued prompt", ["Host guidance"], "queue-1");
        await waitForCalls(trace, 1);
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
            session.send(
                "Queued prompt",
                [],
                ["Host guidance"],
                "intent-queue",
                undefined,
                "queue-1",
            );
        });
        assert.equal(events.filter((event) => event.kind === "text").length, 1);
        const calls = await waitForCalls(trace, 1);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].clientMessageId, "queue-1");
        assert.deepEqual(calls[0].instructions, ["Host guidance"]);
    } finally {
        session.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("removing an immediately queued message waits for native acceptance", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "symposium-genius-queue-remove-"));
    const trace = path.join(root, "calls.jsonl");
    const adapter = new GeniusAdapter(() => ({
        executable: fakeCli,
        model: "test-preset",
        env: { FAKE_GENIUS_MODE: "queued", FAKE_GENIUS_TRACE: trace },
        tokenProvider: () => Promise.resolve(null),
    }));
    const session = adapter.start({ cwd: root, resumeSessionId: sessionId });
    try {
        session.prequeue?.("Discard me", [], "remove-1");
        session.removePrequeued?.("remove-1");
        const calls = await waitForCalls(trace, 2);
        assert.equal(calls[0].clientMessageId, "remove-1");
        assert.deepEqual(calls[1].args.slice(0, 2), ["queue", "remove"]);
    } finally {
        session.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

async function waitForCalls(
    trace: string,
    count: number,
): Promise<Array<{ args: string[]; clientMessageId?: string; instructions?: string[] }>> {
    for (let attempt = 0; attempt < 100; attempt++) {
        if (fs.existsSync(trace)) {
            const calls = fs
                .readFileSync(trace, "utf8")
                .trim()
                .split("\n")
                .map((line) => JSON.parse(line));
            if (calls.length >= count) return calls;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Expected ${count} Genius CLI call(s)`);
}

test("a queued CLI that exits without a result reports a visible turn error", async () => {
    const adapter = new GeniusAdapter(() => ({
        executable: fakeCli,
        model: "test-preset",
        env: { FAKE_GENIUS_MODE: "no_result" },
        tokenProvider: () => Promise.resolve(null),
    }));
    const session = adapter.start({ cwd: process.cwd(), resumeSessionId: sessionId });
    try {
        const events = await new Promise<AgentEvent[]>((resolve, reject) => {
            const collected: AgentEvent[] = [];
            const timeout = setTimeout(() => reject(new Error("CLI turn timed out")), 5000);
            session.on("event", (event: AgentEvent) => {
                collected.push(event);
                if (event.kind === "turn-end") {
                    clearTimeout(timeout);
                    resolve(collected);
                }
            });
            session.send("Prompt", [], [], "intent", undefined, "no-result-1");
        });
        assert.ok(
            events.some(
                (event) => event.kind === "error" && event.message.includes("without a result"),
            ),
        );
    } finally {
        session.dispose();
    }
});
