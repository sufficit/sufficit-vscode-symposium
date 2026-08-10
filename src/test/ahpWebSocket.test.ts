import assert from "node:assert/strict";
import * as http from "node:http";
import test from "node:test";
import { WebSocket } from "ws";
import type { SymposiumApi } from "../api/symposiumApi";
import type { BridgePolicy } from "../api/bridgePolicy";
import { AHP_ROOT_URI, AhpHostRuntime, AhpWebSocketServer, ahpTokenProtocol } from "../ahp";

const TOKEN = "test-token";
const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const CHAT_ID = "22222222-2222-4222-8222-222222222222";
const POLICY: BridgePolicy = {
    allowedRoots: ["/workspace"],
    sessionPermission: "acceptEdits",
    allowedLmTools: [],
    allowExecutableOverride: false,
    allowVaultResolve: false,
    allowedHosts: [],
};

interface Fixture {
    runtime: AhpHostRuntime;
    url: string;
    api: SymposiumApi;
    close(): Promise<void>;
}

async function fixture(
    limits: ConstructorParameters<typeof AhpWebSocketServer>[0]["limits"] = {},
): Promise<Fixture> {
    const runtime = new AhpHostRuntime({ replayCapacity: 4 });
    runtime.registerSession({
        provider: "claude",
        nativeSessionId: "native-1",
        title: "WebSocket",
        cwd: "/workspace",
        stableId: SESSION_ID,
        chatId: CHAT_ID,
    });
    const api = fakeApi();
    const server = http.createServer();
    const ahp = new AhpWebSocketServer({
        server,
        token: TOKEN,
        runtime,
        api,
        policy: POLICY,
        log: () => undefined,
        limits,
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test address");
    return {
        runtime,
        api,
        url: `ws://127.0.0.1:${address.port}/ahp`,
        close: async () => {
            ahp.close();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}

function fakeApi(): SymposiumApi {
    const sessions = new Set(["native-1"]);
    return {
        version: "test",
        sessions: {
            list: () => [],
            status: () => undefined,
            create: (backend: string) => {
                if (backend === "unknown") return Promise.resolve(undefined);
                sessions.add("created-1");
                return Promise.resolve("created-1");
            },
            send: () => false,
            interrupt: () => false,
            dispose: (id: string) => sessions.delete(id),
            follow: () => undefined,
        },
    } as unknown as SymposiumApi;
}

class Peer {
    private readonly messages: unknown[] = [];
    private readonly waiters: Array<() => void> = [];

    constructor(readonly socket: WebSocket) {
        socket.on("message", (data) => {
            this.messages.push(JSON.parse(data.toString()));
            this.waiters.shift()?.();
        });
    }

    send(value: unknown): void {
        this.socket.send(JSON.stringify(value));
    }

    async next(
        predicate: (value: Record<string, unknown>) => boolean,
    ): Promise<Record<string, unknown>> {
        const deadline = Date.now() + 2_000;
        while (Date.now() < deadline) {
            const index = this.messages.findIndex((value) =>
                predicate(value as Record<string, unknown>),
            );
            if (index >= 0) return this.messages.splice(index, 1)[0] as Record<string, unknown>;
            await new Promise<void>((resolve) => {
                this.waiters.push(resolve);
                setTimeout(resolve, 25);
            });
        }
        throw new Error("timed out waiting for WebSocket message");
    }
}

async function connect(url: string, mode: "header" | "protocol" = "header"): Promise<Peer> {
    const socket =
        mode === "protocol"
            ? new WebSocket(url, ["ahp.v0.6", ahpTokenProtocol(TOKEN)])
            : new WebSocket(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
    await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
    });
    return new Peer(socket);
}

function initialize(peer: Peer, id = 1, versions = ["0.6.0"]): void {
    peer.send({
        jsonrpc: "2.0",
        id,
        method: "initialize",
        params: {
            channel: AHP_ROOT_URI,
            clientId: `client-${id}`,
            protocolVersions: versions,
            initialSubscriptions: [AHP_ROOT_URI],
        },
    });
}

test("AHP WebSocket rejects URL tokens and accepts header/subprotocol auth", async () => {
    const current = await fixture();
    try {
        const status = await new Promise<number>((resolve) => {
            const socket = new WebSocket(`${current.url}?token=${TOKEN}`);
            socket.on("unexpected-response", (_request, response) =>
                resolve(response.statusCode ?? 0),
            );
            socket.on("error", () => undefined);
        });
        assert.equal(status, 401);
        const header = await connect(current.url, "header");
        const protocol = await connect(current.url, "protocol");
        assert.equal(protocol.socket.protocol, "ahp.v0.6");
        header.socket.close();
        protocol.socket.close();
    } finally {
        await current.close();
    }
});

test("AHP WebSocket negotiates protocol and returns initial snapshots", async () => {
    const current = await fixture();
    try {
        const peer = await connect(current.url);
        initialize(peer, 1, ["9.0.0"]);
        const unsupported = await peer.next((value) => value.id === 1);
        assert.equal((unsupported.error as { code: number }).code, -32005);
        peer.socket.close();

        const valid = await connect(current.url);
        initialize(valid, 2);
        const response = await valid.next((value) => value.id === 2);
        const result = response.result as { protocolVersion: string; snapshots: unknown[] };
        assert.equal(result.protocolVersion, "0.6.0");
        assert.equal(result.snapshots.length, 1);
        valid.socket.close();
    } finally {
        await current.close();
    }
});

test("AHP subscribers observe identical globally ordered actions", async () => {
    const current = await fixture();
    try {
        const first = await connect(current.url);
        const second = await connect(current.url);
        initialize(first, 1);
        initialize(second, 2);
        await first.next((value) => value.id === 1);
        await second.next((value) => value.id === 2);
        for (const [peer, id] of [
            [first, 3],
            [second, 4],
        ] as const) {
            peer.send({
                jsonrpc: "2.0",
                id,
                method: "subscribe",
                params: { channel: current.runtime.handles()[0].sessionResource },
            });
            await peer.next((value) => value.id === id);
        }
        current.runtime.dispatch(current.runtime.handles()[0].sessionResource, {
            type: "session/titleChanged",
            title: "ordered",
        });
        const a = await first.next((value) => value.method === "action");
        const b = await second.next((value) => value.method === "action");
        assert.deepEqual(a.params, b.params);
        first.socket.close();
        second.socket.close();
    } finally {
        await current.close();
    }
});

test("AHP reconnect returns retained tails and snapshot fallback", async () => {
    const current = await fixture();
    try {
        const resource = current.runtime.handles()[0].sessionResource;
        const before = current.runtime.store.serverSeq;
        current.runtime.dispatch(resource, { type: "session/titleChanged", title: "one" });
        const replay = await connect(current.url);
        replay.send({
            jsonrpc: "2.0",
            id: 1,
            method: "reconnect",
            params: {
                channel: AHP_ROOT_URI,
                clientId: "replay",
                lastSeenServerSeq: before,
                subscriptions: [resource],
            },
        });
        const replayResult = (await replay.next((value) => value.id === 1)).result as {
            type: string;
            actions: unknown[];
        };
        assert.equal(replayResult.type, "replay");
        assert.equal(replayResult.actions.length, 1);
        for (let index = 0; index < 10; index++) {
            current.runtime.dispatch(resource, {
                type: "session/titleChanged",
                title: String(index),
            });
        }
        const old = await connect(current.url);
        old.send({
            jsonrpc: "2.0",
            id: 2,
            method: "reconnect",
            params: {
                channel: AHP_ROOT_URI,
                clientId: "old",
                lastSeenServerSeq: 0,
                subscriptions: [resource],
            },
        });
        assert.equal(
            ((await old.next((value) => value.id === 2)).result as { type: string }).type,
            "snapshot",
        );
        replay.socket.close();
        old.socket.close();
    } finally {
        await current.close();
    }
});

test("AHP WebSocket rejects malformed, over-limit and slow clients", async () => {
    const malformedFixture = await fixture({ maxMalformedFrames: 2, maxFrameBytes: 512 });
    try {
        const malformed = await connect(malformedFixture.url);
        malformed.socket.send("{");
        await malformed.next((value) => !!value.error);
        const closed = new Promise<number>((resolve) => malformed.socket.once("close", resolve));
        malformed.socket.send("{");
        assert.equal(await closed, 1008);
        const oversized = await connect(malformedFixture.url);
        const oversizedClose = new Promise<number>((resolve) =>
            oversized.socket.once("close", resolve),
        );
        oversized.socket.send("x".repeat(2_000));
        assert.equal(await oversizedClose, 1009);
    } finally {
        await malformedFixture.close();
    }

    const slowFixture = await fixture({ maxQueuedBytes: 32 });
    try {
        const slow = await connect(slowFixture.url);
        const closed = new Promise<number>((resolve) => slow.socket.once("close", resolve));
        initialize(slow);
        assert.equal(await closed, 1013);
    } finally {
        await slowFixture.close();
    }
});

test("AHP session creation reuses Bridge root and permission policy", async () => {
    const current = await fixture();
    try {
        const peer = await connect(current.url);
        initialize(peer);
        await peer.next((value) => value.id === 1);
        peer.send({
            jsonrpc: "2.0",
            id: 2,
            method: "createSession",
            params: {
                channel: "ahp-session:/33333333-3333-4333-8333-333333333333",
                provider: "claude",
                workingDirectory: "file:///outside",
            },
        });
        const denied = await peer.next((value) => value.id === 2);
        assert.equal((denied.error as { code: number }).code, -32009);
        peer.socket.close();
    } finally {
        await current.close();
    }
});
