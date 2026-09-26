import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { GeniusAdapter } from "../adapters/genius/adapter";

const fakeCli = path.resolve(__dirname, "../../test/fixtures/fake-genius-cli.cjs");
const sessionId = "11111111-2222-4333-8444-555555555555";

test("Genius adapter renames a native session through the CLI", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "symposium-genius-title-"));
    const trace = path.join(root, "calls.jsonl");
    const adapter = new GeniusAdapter(() => ({
        executable: fakeCli,
        model: "",
        env: { FAKE_GENIUS_TRACE: trace },
    }));
    try {
        await adapter.renameSession({ backend: "genius", sessionId, title: "Old" }, "Shared title");
        const call = JSON.parse(fs.readFileSync(trace, "utf8").trim()) as { args: string[] };
        assert.deepEqual(call.args, ["sessions", "rename", sessionId, "Shared title", "--json"]);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
