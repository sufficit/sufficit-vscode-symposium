import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { GeniusAdapter } from "../adapters/genius/adapter";
import type { AgentEvent } from "../adapters/types";

const fakeCli = path.resolve(__dirname, "../../test/fixtures/fake-genius-cli.cjs");

test("Genius catalog populates the picker and context usage with delegated authentication", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "symposium-genius-catalog-"));
    const trace = path.join(root, "calls.jsonl");
    const adapter = new GeniusAdapter(() => ({
        executable: fakeCli,
        model: "",
        env: { FAKE_GENIUS_TRACE: trace },
        tokenProvider: () => Promise.resolve("delegated-test-token"),
    }));
    try {
        const catalog = await adapter.refreshModels();
        assert.deepEqual(catalog.models, ["default", "test-preset", "unknown-window"]);
        assert.equal(catalog.labels?.["test-preset"], "Test preset");

        const session = adapter.start({ cwd: root, model: "default" });
        const events: AgentEvent[] = [];
        try {
            await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error("Genius turn timed out")), 5000);
                session.on("event", (event: AgentEvent) => {
                    events.push(event);
                    if (event.kind !== "turn-end") return;
                    clearTimeout(timer);
                    resolve();
                });
                session.send("Hello");
            });
        } finally {
            session.dispose();
        }
        const usage = events.find((event) => event.kind === "usage");
        assert.equal(usage?.kind === "usage" ? usage.contextWindow : undefined, 128000);
        const calls = fs
            .readFileSync(trace, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as { args: string[]; authToken: string | null });
        assert.deepEqual(calls[0].args, ["models", "--json"]);
        assert.equal(calls[0].authToken, "delegated-test-token");
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
