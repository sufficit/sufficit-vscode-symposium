import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { HOST_MESSAGE_TYPES } from "../protocol/chat";

const webviewRoot = resolve(__dirname, "../../src/ui/webview");
const receiverSource = readdirSync(webviewRoot)
    .filter((file) => file.endsWith(".ts") && file !== "pwaShim.ts")
    .map((file) => readFileSync(resolve(webviewRoot, file), "utf8"))
    .join("\n");

function receiverDeclares(type: string): boolean {
    const quoted = type.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return (
        new RegExp(`case\\s+["']${quoted}["']`).test(receiverSource) ||
        new RegExp(`\\.type\\s*===\\s*["']${quoted}["']`).test(receiverSource)
    );
}

test("every closed host message type has a browser receiver", () => {
    const missing = HOST_MESSAGE_TYPES.filter((type) => !receiverDeclares(type));
    assert.deepEqual(missing, []);
});

test("chat protocol does not fall back to an unconstrained string discriminant", () => {
    const protocol = readFileSync(resolve(__dirname, "../../src/protocol/chat.ts"), "utf8");
    assert.doesNotMatch(protocol, /HostToWebview\s*=\s*\{\s*type:\s*string/);
    assert.match(protocol, /HostMessageType = \(typeof HOST_MESSAGE_TYPES\)\[number\]/);
});
