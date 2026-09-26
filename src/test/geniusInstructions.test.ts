import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { GeniusAdapter } from "../adapters/genius/adapter";
import type { AgentEvent, AgentSession } from "../adapters/types";

const fakeCli = path.resolve(__dirname, "../../test/fixtures/fake-genius-cli.cjs");

function collectTurn(session: AgentSession, prompt: string, instructions: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Genius turn timed out")), 5000);
        const onEvent = (event: AgentEvent) => {
            if (event.kind !== "turn-end") return;
            clearTimeout(timer);
            session.off("event", onEvent);
            resolve();
        };
        session.on("event", onEvent);
        session.send(prompt, undefined, instructions, "intent-1");
    });
}

test("Genius sends Symposium guidance as instructions, separate from the user prompt", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "symposium-genius-instructions-"));
    const trace = path.join(root, "calls.jsonl");
    const adapter = new GeniusAdapter(() => ({
        executable: fakeCli,
        model: "test-preset",
        env: { FAKE_GENIUS_TRACE: trace },
    }));
    const session = adapter.start({ cwd: root });
    try {
        assert.equal(adapter.roleAware(), true);
        await collectTurn(session, "Actual user request", ["Symposium host guidance"]);
        const call = JSON.parse(fs.readFileSync(trace, "utf8").trim()) as {
            prompt: string;
            instructions: string[];
        };
        assert.equal(call.prompt, "Actual user request");
        assert.deepEqual(call.instructions, ["Symposium host guidance"]);
    } finally {
        session.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    }
});
