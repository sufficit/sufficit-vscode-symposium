import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { AhpHostRuntime, AhpPersistence } from "../ahp";

test("AHP persistence merges sessions written by sibling Extension Hosts", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "symposium-ahp-multi-host-"));
    try {
        const first = runtime("openai", "native-1", "11111111", "22222222", "IXC");
        const second = runtime("claude", "native-2", "33333333", "44444444", "Other");
        const firstHost = new AhpPersistence(directory);
        const secondHost = new AhpPersistence(directory);
        firstHost.saveSync(first);
        firstHost.flushSync();
        secondHost.saveSync(second);
        secondHost.flushSync();

        const restored = new AhpPersistence(directory).load();
        assert.ok(restored);
        assert.deepEqual(restored.sessions.map((session) => session.nativeSessionId).sort(), [
            "native-1",
            "native-2",
        ]);
        assert.equal(restored.retainedActions.length, 0);
        assert.deepEqual(
            fs.readdirSync(path.join(directory, "ahp")).filter((file) => file.endsWith(".lock")),
            [],
        );
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

function runtime(
    provider: string,
    nativeSessionId: string,
    sessionPrefix: string,
    chatPrefix: string,
    title: string,
): AhpHostRuntime {
    const value = new AhpHostRuntime({ replayCapacity: 20 });
    value.registerSession({
        provider,
        nativeSessionId,
        stableId: `${sessionPrefix}-1111-4111-8111-111111111111`,
        chatId: `${chatPrefix}-2222-4222-8222-222222222222`,
        title,
    });
    return value;
}
