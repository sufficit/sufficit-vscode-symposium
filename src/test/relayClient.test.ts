import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import {
    parseRelayMessage,
    buildRegisterMessage,
    buildHeartbeatMessage,
    getMachineId,
    RelayClient,
} from "../net/relayClient";
import { localAhpUrl, relayProtocols, RelaySocketTunnel } from "../net/relaySocketTunnel";

// --- Relay Sufficit: protocolo e cliente WS outbound ---
// O relay publica o bridge local numa URL pública via WS outbound para o gateway
// Sufficit. Estes testes cobrem as funções puras do protocolo (parse/build de
// mensagens) e o lifecycle do RelayClient (machineId estável, getPublicUrl).

test("parseRelayMessage parses a valid relay message", () => {
    const msg = parseRelayMessage(
        '{"type":"registered","publicUrl":"https://ai.sufficit.com.br/symposium/abc"}',
    );
    assert.ok(msg);
    assert.equal(msg!.type, "registered");
    assert.equal(msg!.publicUrl, "https://ai.sufficit.com.br/symposium/abc");
});

test("parseRelayMessage returns undefined for non-JSON", () => {
    assert.equal(parseRelayMessage("not json"), undefined);
});

test("parseRelayMessage returns undefined for valid JSON without a type string", () => {
    assert.equal(parseRelayMessage('{"foo":"bar"}'), undefined);
    assert.equal(parseRelayMessage('{"type":123}'), undefined);
    assert.equal(parseRelayMessage("[]"), undefined);
});

test("parseRelayMessage returns undefined for empty/null input", () => {
    assert.equal(parseRelayMessage(""), undefined);
});

test("parseRelayMessage parses a request message (HTTP proxy)", () => {
    const raw =
        '{"type":"request","id":"r1","method":"GET","path":"/health","headers":{},"body":""}';
    const msg = parseRelayMessage(raw);
    assert.ok(msg);
    assert.equal(msg!.type, "request");
    assert.equal(msg!.id, "r1");
    assert.equal(msg!.method, "GET");
    assert.equal(msg!.path, "/health");
});

test("buildRegisterMessage produces valid JSON with machineId", () => {
    const raw = buildRegisterMessage("machine-123");
    const msg = JSON.parse(raw);
    assert.equal(msg.type, "register");
    assert.equal(msg.machineId, "machine-123");
});

test("buildHeartbeatMessage produces valid JSON", () => {
    const msg = JSON.parse(buildHeartbeatMessage());
    assert.equal(msg.type, "heartbeat");
});

test("getMachineId is stable across calls within a session", () => {
    // getMachineId reads/writes ~/.symposium/relay-machine-id. Two calls must
    // return the same id (the file persists after the first call).
    const id1 = getMachineId();
    const id2 = getMachineId();
    assert.equal(id1, id2);
    assert.match(id1, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
});

test("getMachineId uses the persisted file when present", () => {
    // Simulate a pre-existing machine id file by reading what getMachineId wrote
    // and confirming a fresh process would read the same value.
    const file = path.join(os.homedir(), ".symposium", "relay-machine-id");
    const before = fs.readFileSync(file, "utf8").trim();
    const id = getMachineId();
    assert.equal(id, before);
});

test("RelayClient.getPublicUrl returns undefined before registration", () => {
    const client = new RelayClient({
        relayUrl: "wss://test.invalid/relay",
        bridgePort: 47600,
        getToken: () => Promise.resolve("fake-token"),
    });
    assert.equal(client.getPublicUrl(), undefined);
    client.stop();
});

test("RelayClient.stop is idempotent (no throw on double stop)", () => {
    const client = new RelayClient({
        relayUrl: "wss://test.invalid/relay",
        bridgePort: 47600,
        getToken: () => Promise.resolve(null),
    });
    client.stop();
    client.stop(); // must not throw
});

test("relay socket tunnel negotiates AHP and forwards messages in both directions", async () => {
    const server = http.createServer();
    const webSockets = new WebSocketServer({
        server,
        path: "/ahp",
        handleProtocols: (protocols) => (protocols.has("ahp.v0.6") ? "ahp.v0.6" : false),
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const connected = new Promise<WebSocket>((resolve) => webSockets.once("connection", resolve));
    const sent: Record<string, unknown>[] = [];
    const tunnel = new RelaySocketTunnel({
        bridgePort: address.port,
        send: (message) => sent.push(message),
    });

    try {
        assert.equal(
            tunnel.handleMessage({
                type: "socket-open",
                id: "socket-1",
                path: "/ahp",
                protocols: ["ahp.v0.6", "symposium-token.dGVzdA"],
            }),
            true,
        );
        const local = await connected;
        const opened = await waitForMessage(sent, "socket-opened");
        assert.equal(opened.id, "socket-1");
        assert.equal(opened.protocol, "ahp.v0.6");

        const received = new Promise<string>((resolve) =>
            local.once("message", (data) => resolve(data.toString())),
        );
        tunnel.handleMessage({
            type: "socket-frame",
            id: "socket-1",
            data: Buffer.from("browser-to-host").toString("base64"),
            binary: false,
        });
        assert.equal(await received, "browser-to-host");

        local.send("host-to-browser");
        const response = await waitForMessage(sent, "socket-frame");
        assert.equal(Buffer.from(String(response.data), "base64").toString(), "host-to-browser");
        assert.equal(response.binary, false);

        tunnel.handleMessage({ type: "socket-close", id: "socket-1", code: 1000, reason: "done" });
        await new Promise<void>((resolve) => local.once("close", () => resolve()));
    } finally {
        tunnel.closeAll();
        await new Promise<void>((resolve) => webSockets.close(() => resolve()));
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});

test("relay socket tunnel only targets local AHP and filters invalid protocols", () => {
    assert.equal(localAhpUrl("/ahp", 47600), "ws://127.0.0.1:47600/ahp");
    assert.equal(localAhpUrl("/sessions", 47600), undefined);
    assert.equal(localAhpUrl("//attacker.example/ahp", 47600), undefined);
    assert.deepEqual(relayProtocols(["ahp.v0.6", "bad protocol", "x\r\nheader"]), ["ahp.v0.6"]);
});

async function waitForMessage(
    messages: Record<string, unknown>[],
    type: string,
): Promise<Record<string, unknown>> {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
        const found = messages.find((message) => message.type === type);
        if (found) return found;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`timed out waiting for ${type}`);
}
