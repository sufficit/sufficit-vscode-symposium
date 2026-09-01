import assert from "node:assert/strict";
import test from "node:test";
import type { AgentAdapter, SessionInfo } from "../adapters/types";
import { ChatController } from "../application/chatController";
import type { ApplicationPorts } from "../application/ports";
import { SurfaceDialogues } from "../ui/surfaceDialogues";
import type { SurfaceDialoguesDeps } from "../ui/surfaceDialoguesTypes";

test("reopening a live controller reprojects history instead of trusting an empty AHP snapshot", async () => {
    const info: SessionInfo = {
        backend: "claude",
        sessionId: "native-history",
        title: "History",
        updatedAt: new Date(0),
        status: "idle",
        transcriptPath: "/tmp/native-history.jsonl",
    };
    let historyLoads = 0;
    let transient: boolean | undefined;
    const controller = {
        sessionKey: info.sessionId,
        sessionId: info.sessionId,
        isBusy: false,
        seedRenderLog: () => assert.fail("a live controller must not be seeded again"),
        loadHistory: (_info: SessionInfo, isTransient?: boolean) => {
            historyLoads++;
            transient = isTransient;
            return Promise.resolve();
        },
        getModel: () => "",
        getPermission: () => "manager",
        aiToolsInfo: () => undefined,
        subscribeLive: () => () => undefined,
    };
    const adapter = {
        backend: "claude",
        displayName: "Claude",
        models: () => [],
        modelLabels: () => ({}),
        reasoningLevels: () => [],
        defaultReasoning: () => "default",
        permissionModes: () => [],
        defaultPermission: () => "default",
    } as unknown as AgentAdapter;
    const posts: unknown[] = [];
    const deps = {
        deps: {
            adapterByBackend: new Map([["claude", adapter]]),
            cwdFor: () => "/workspace",
            runtime: {
                findBySessionId: () => controller,
                create: () => assert.fail("the existing controller must be reused"),
            },
            ahp: { sync: () => undefined },
            modelPrefs: { getDefault: () => "", getPinned: () => [] },
            lastActive: { set: () => undefined },
        },
        chatOnly: false,
        post: (message: unknown) => posts.push(message),
        setSendBlockedReason: () => undefined,
        detachActive: () => undefined,
        setController: () => undefined,
        getController: () => controller,
        buildLangHint: () => "",
        activateUsage: () => undefined,
        bindAhp: () => () => undefined,
        setControllerDetach: () => undefined,
        sync: {
            refreshTasks: () => Promise.resolve(),
            refreshGuardrails: () => Promise.resolve(),
            postCommands: () => undefined,
            refreshModels: () => undefined,
        },
    } as unknown as SurfaceDialoguesDeps;

    new SurfaceDialogues(deps).openSession(info);
    await Promise.resolve();

    assert.equal(historyLoads, 1);
    assert.equal(transient, true, "reprojection must not append derived history to the ledger");
    assert.equal(
        posts.some((message) => (message as { type?: string }).type === "history-end"),
        true,
    );
    const meta = posts.find((message) => (message as { type?: string }).type === "meta") as {
        permission?: string;
        permissionDefault?: string;
    };
    assert.equal(meta.permission, "manager", "the picker must show the live controller policy");
    assert.equal(
        meta.permissionDefault,
        "default",
        "the adapter default remains separately marked",
    );
});

test("transient history reaches the live projection without entering the persisted stream", async () => {
    const info: SessionInfo = {
        backend: "claude",
        sessionId: "88888888-8888-4888-8888-888888888888",
        title: "Transient history",
        updatedAt: new Date(0),
        status: "idle",
    };
    const adapter = {
        backend: "claude",
        history: () => Promise.resolve({ messages: [{ role: "user" as const, text: "restored" }] }),
    } as unknown as AgentAdapter;
    const controller = new ChatController(
        adapter,
        { cwd: "/workspace", resumeSessionId: info.sessionId },
        {} as ApplicationPorts,
    );
    const live: unknown[] = [];
    controller.subscribeLive((message) => live.push(message));

    await controller.loadHistory(info, true);

    assert.equal(
        live.some((message) => (message as { type?: string }).type === "history"),
        true,
        "the AHP live observer receives the authoritative replacement",
    );
    const replayed: unknown[] = [];
    controller.subscribe((message) => replayed.push(message));
    assert.equal(
        replayed.some((message) => (message as { type?: string }).type === "history"),
        false,
        "derived history is not appended to the stream or render ledger",
    );
});
