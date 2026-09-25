import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { GeniusAdapter } from "../adapters/genius/adapter";

const fakeCli = path.resolve(__dirname, "../../test/fixtures/fake-genius-cli.cjs");

test("Genius default model does not become an explicit CLI preset", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "symposium-genius-default-"));
    const trace = path.join(root, "calls.jsonl");
    const adapter = new GeniusAdapter(() => ({
        executable: fakeCli,
        model: "",
        env: { FAKE_GENIUS_TRACE: trace },
    }));
    const session = adapter.start({ cwd: root, model: "default" });
    try {
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("Genius turn timed out")), 5000);
            session.on("event", (event: { kind: string }) => {
                if (event.kind !== "turn-end") return;
                clearTimeout(timer);
                resolve();
            });
            session.send("Hello");
        });
        const call = JSON.parse(fs.readFileSync(trace, "utf8").trim()) as { args: string[] };
        assert.ok(!call.args.includes("--preset"));
    } finally {
        session.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    }
});
