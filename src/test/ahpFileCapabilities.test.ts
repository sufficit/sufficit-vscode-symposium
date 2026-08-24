import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { URI } from "@microsoft/agent-host-protocol";
import {
    AhpCapabilityRegistry,
    AhpChangesetChannel,
    AhpHostRuntime,
    AhpResourceChannel,
} from "../ahp";

test("changeset channel publishes bounded metadata and reconciles decisions", async () => {
    await withFiles(async ({ root, file, outside }) => {
        const runtime = new AhpHostRuntime();
        const handle = runtime.registerSession({
            provider: "codex",
            nativeSessionId: "changeset-session",
            title: "Changes",
            cwd: root,
        });
        const decisions: string[] = [];
        const channel = new AhpChangesetChannel(runtime, new AhpCapabilityRegistry(runtime), {
            enabled: true,
            allowedRoots: [root],
            decide: (target, decision) => {
                decisions.push(`${decision}:${target}`);
            },
        });
        const resource = channel.publish(handle, "turn-1", [{ path: file, added: 2, removed: 1 }]);
        assert.ok(resource);
        const snapshot = runtime.snapshot(resource!).state as unknown as any;
        assert.equal(snapshot.files.length, 1);
        assert.equal(snapshot.files[0].path, "inside.txt");
        assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(escapeRegExp(root)));
        assert.throws(() =>
            channel.publish(handle, undefined, [{ path: outside, added: 1, removed: 0 }]),
        );

        const decision = {
            clientId: "client-a",
            resource: resource!,
            fileId: snapshot.files[0].id,
            decision: "apply" as const,
            expectedVersion: snapshot.version,
        };
        assert.deepEqual(await channel.decide(decision), { accepted: true });
        assert.deepEqual(await channel.decide(decision), { accepted: true });
        assert.equal(decisions.length, 1);
        assert.deepEqual(await channel.decide({ ...decision, decision: "reject" }), {
            accepted: false,
            reason: "stale version",
        });
    });
});

test("resource channel enforces root, symlink, ownership, protection and size limits", async () => {
    await withFiles(({ root, file, outside }) => {
        const runtime = new AhpHostRuntime();
        const first = runtime.registerSession({
            provider: "claude",
            nativeSessionId: "resource-1",
            title: "One",
            cwd: root,
        });
        const second = runtime.registerSession({
            provider: "claude",
            nativeSessionId: "resource-2",
            title: "Two",
            cwd: root,
        });
        const resources = new AhpResourceChannel(runtime, new AhpCapabilityRegistry(runtime), {
            enabled: true,
            allowedRoots: [root],
            maxReadBytes: 4,
        });
        const reference = resources.register(first, file);
        assert.equal(resources.read(reference, first.chatResource).toString(), "insi");
        assert.throws(() => resources.read(reference, second.chatResource), /ownership/);

        const secret = path.join(root, ".env");
        fs.writeFileSync(secret, "TOKEN=secret");
        const protectedReference = resources.register(first, secret);
        assert.throws(
            () => resources.read(protectedReference, first.chatResource),
            /authentication/,
        );
        assert.equal(
            resources.read(protectedReference, first.chatResource, 0, 4, true).toString(),
            "TOKE",
        );
        assert.doesNotMatch(
            JSON.stringify(runtime.snapshot(protectedReference)),
            /TOKEN=secret|\.env/,
        );

        const link = path.join(root, "outside-link");
        fs.symlinkSync(outside, link);
        assert.throws(() => resources.register(first, link), /outside/);
        resources.disposeSession(first.sessionResource as URI);
        assert.equal(runtime.store.has(reference), false);
    });
});

async function withFiles(
    run: (files: { root: string; file: string; outside: string }) => void | Promise<void>,
): Promise<void> {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "symposium-ahp-files-"));
    const root = path.join(base, "workspace");
    const outside = path.join(base, "outside.txt");
    fs.mkdirSync(root);
    const file = path.join(root, "inside.txt");
    fs.writeFileSync(file, "inside content");
    fs.writeFileSync(outside, "outside content");
    try {
        await run({ root, file, outside });
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
