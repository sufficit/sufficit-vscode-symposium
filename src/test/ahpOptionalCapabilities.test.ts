import assert from "node:assert/strict";
import { test } from "node:test";
import type { RootState } from "@microsoft/agent-host-protocol";
import {
    AHP_CAPABILITIES,
    AhpCapabilityRegistry,
    AhpClientTools,
    AhpCustomizationChannels,
    AhpHostRuntime,
    AhpTelemetry,
    AhpTerminalChannel,
} from "../ahp";

test("terminal channel has exclusive claims, bounded redacted output and disconnect cleanup", () => {
    const runtime = new AhpHostRuntime();
    const handle = runtime.registerSession({
        provider: "openai",
        nativeSessionId: "terminal-session",
        title: "Terminal",
        cwd: "/workspace",
    });
    const inputs: string[] = [];
    const terminal = new AhpTerminalChannel(runtime, new AhpCapabilityRegistry(runtime), {
        enabled: true,
        maxOutputChars: 32,
        maxInputBytes: 8,
        input: (text) => inputs.push(text),
        resize: () => undefined,
        allowed: (permission) => permission === "admin",
    });
    const resource = terminal.create(handle, "main");
    assert.equal(terminal.claim(resource, "client-a", "admin"), true);
    assert.equal(terminal.claim(resource, "client-b", "admin"), false);
    terminal.append(resource, "authorization=very-secret-value\nready");
    const state = runtime.snapshot(resource).state as unknown as {
        output: string;
        claimedBy?: string;
        offset: number;
    };
    assert.ok(state.output.length <= 32);
    assert.doesNotMatch(state.output, /very-secret-value/);
    terminal.input(resource, "client-a", "ls\n");
    assert.deepEqual(inputs, ["ls\n"]);
    assert.throws(() => terminal.input(resource, "client-b", "pwd\n"), /not owned/);
    terminal.disconnect("client-a");
    assert.equal(
        (runtime.snapshot(resource).state as unknown as { claimedBy?: string }).claimedBy,
        undefined,
    );
});

test("customization channel redacts host config and requires an ephemeral protected grant", async () => {
    const runtime = new AhpHostRuntime();
    const customizations = new AhpCustomizationChannels(
        runtime,
        new AhpCapabilityRegistry(runtime),
        {
            enabledKinds: ["agent", "mcp"],
            authorized: () => true,
            authenticate: () => Promise.resolve(true),
        },
    );
    customizations.publish([
        { kind: "agent", name: "reviewer", description: "Reviews code" },
        {
            kind: "mcp",
            name: "private-db",
            protected: true,
            configuration: { url: "https://internal", token: "secret-token" },
            credential: "secret-token",
        },
        { kind: "skill", name: "disabled-skill" },
    ]);
    const snapshot = JSON.stringify(runtime.snapshot(customizations.resource));
    assert.doesNotMatch(snapshot, /secret-token|https:\/\/internal|disabled-skill/);
    assert.equal(
        customizations.discover("client-a").find((item) => item.name === "private-db")?.available,
        false,
    );
    const challenge = customizations.beginAuthentication("client-a", "mcp", "private-db");
    assert.equal(await customizations.completeAuthentication("client-a", challenge), true);
    assert.equal(
        customizations.discover("client-a").find((item) => item.name === "private-db")?.available,
        true,
    );
    customizations.disconnect("client-a");
    assert.equal(
        customizations.discover("client-a").find((item) => item.name === "private-db")?.available,
        false,
    );
});

test("client tools enforce namespace, ownership, limits, timeout and disconnect", async () => {
    const runtime = new AhpHostRuntime();
    const registry = new AhpCapabilityRegistry(runtime);
    const tools = new AhpClientTools(registry, {
        enabled: true,
        maxToolsPerClient: 1,
        maxSchemaBytes: 100,
        maxConcurrentPerTool: 1,
        timeoutMs: 20,
        allowed: (_client, permission) => permission === "manager",
    });
    const name = tools.register("client/a", {
        name: "lookup",
        schema: { type: "object" },
        invoke: (input) => Promise.resolve(input),
    });
    assert.equal(name, "client.client_a.lookup");
    assert.throws(
        () =>
            tools.register("client/a", {
                name: "second",
                schema: {},
                invoke: () => Promise.resolve(null),
            }),
        /limit/,
    );
    await assert.rejects(() => tools.invoke(name, {}, "user"), /not allowed/);
    assert.deepEqual(await tools.invoke(name, { id: 1 }, "manager"), { id: 1 });

    tools.unregister("client/a", name);
    const slow = tools.register("client/a", {
        name: "slow",
        schema: {},
        invoke: () => new Promise(() => undefined),
    });
    await assert.rejects(() => tools.invoke(slow, {}, "manager"), /timed out/);
    const pending = tools.invoke(slow, {}, "manager");
    tools.disconnect("client/a");
    await assert.rejects(() => pending, /client disconnected/);
    assert.equal(tools.list().length, 0);
});

test("telemetry is ephemeral, consent gated, label bounded and failure isolated", async () => {
    const runtime = new AhpHostRuntime();
    const exported: unknown[][] = [];
    const telemetry = new AhpTelemetry(new AhpCapabilityRegistry(runtime), {
        enabled: true,
        consent: true,
        allowedLabels: { reason: ["stale", "policy"] },
        exporter: {
            export: (batch) => {
                exported.push([...batch]);
                return Promise.reject(new Error("collector offline"));
            },
        },
    });
    telemetry.measure("ahp.action.rejected", 1, {
        reason: "policy",
        prompt: "must never be exported",
    });
    assert.equal(telemetry.pending(), 1);
    telemetry.flush();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(exported.length, 1);
    assert.deepEqual((exported[0][0] as { labels: Record<string, string> }).labels, {
        reason: "policy",
    });

    const root = runtime.snapshot("ahp-root://").state as RootState;
    const capabilities = (root._meta?.symposium as { capabilities?: string[] }).capabilities ?? [];
    assert.ok(capabilities.includes(AHP_CAPABILITIES.telemetry));
    assert.doesNotMatch(JSON.stringify(runtime.exportState()), /must never be exported/);

    const disabled = new AhpTelemetry(new AhpCapabilityRegistry(new AhpHostRuntime()), {
        enabled: true,
        consent: false,
        exporter: { export: () => Promise.resolve() },
    });
    disabled.measure("ahp.reconnect.count", 1);
    assert.equal(disabled.pending(), 0);
});
