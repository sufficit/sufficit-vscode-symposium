import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
    parseRelayMessage,
    buildRegisterMessage,
    buildHeartbeatMessage,
    getMachineId,
    RelayClient,
} from "../net/relayClient";

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
