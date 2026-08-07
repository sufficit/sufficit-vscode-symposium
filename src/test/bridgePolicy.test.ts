import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "path";
import {
    resolveBridgePolicy,
    isCwdAllowed,
    isLmToolAllowed,
    isHostAllowed,
    SAFE_SESSION_PERMISSIONS,
} from "../api/bridgePolicy";

test("resolveBridgePolicy falls back to workspace roots and resolves them", () => {
    const p = resolveBridgePolicy({ allowedRoots: [], workspaceRoots: ["/home/u/proj", ""] });
    assert.deepEqual(p.allowedRoots, [path.resolve("/home/u/proj")]);
});

test("resolveBridgePolicy prefers configured roots over workspace roots", () => {
    const p = resolveBridgePolicy({ allowedRoots: ["/srv/a"], workspaceRoots: ["/home/u/proj"] });
    assert.deepEqual(p.allowedRoots, [path.resolve("/srv/a")]);
});

test("resolveBridgePolicy clamps unsafe permission modes to acceptEdits", () => {
    assert.equal(
        resolveBridgePolicy({ sessionPermission: "bypassPermissions" }).sessionPermission,
        "acceptEdits",
    );
    assert.equal(
        resolveBridgePolicy({ sessionPermission: "never" }).sessionPermission,
        "acceptEdits",
    );
    assert.equal(
        resolveBridgePolicy({ sessionPermission: "garbage" }).sessionPermission,
        "acceptEdits",
    );
    for (const safe of SAFE_SESSION_PERMISSIONS) {
        assert.equal(resolveBridgePolicy({ sessionPermission: safe }).sessionPermission, safe);
    }
});

test("resolveBridgePolicy defaults dangerous toggles to false", () => {
    const p = resolveBridgePolicy({});
    assert.equal(p.allowExecutableOverride, false);
    assert.equal(p.allowVaultResolve, false);
    assert.deepEqual(p.allowedLmTools, []);
});

test("isCwdAllowed confines to roots and fails closed", () => {
    const roots = [path.resolve("/home/u/proj")];
    assert.equal(isCwdAllowed("/home/u/proj", roots), true);
    assert.equal(isCwdAllowed("/home/u/proj/sub/dir", roots), true);
    assert.equal(isCwdAllowed("/home/u/other", roots), false);
    assert.equal(isCwdAllowed("/home/u/proj-evil", roots), false); // prefix but not a child
    assert.equal(isCwdAllowed("/home/u/proj/../secret", roots), false); // normalizes out of root
    assert.equal(isCwdAllowed("/home/u/proj", []), false); // no roots = deny all
    assert.equal(isCwdAllowed("", roots), false);
    assert.equal(isCwdAllowed(undefined, roots), false);
});

test("isLmToolAllowed denies unless exact name is listed", () => {
    assert.equal(isLmToolAllowed("copilot_readFile", ["copilot_readFile"]), true);
    assert.equal(isLmToolAllowed("runInTerminal", ["copilot_readFile"]), false);
    assert.equal(isLmToolAllowed("anything", []), false);
    assert.equal(isLmToolAllowed(undefined, ["x"]), false);
});

test("isHostAllowed always accepts loopback and enforces the allowlist otherwise", () => {
    assert.equal(isHostAllowed("127.0.0.1:47600", []), true);
    assert.equal(isHostAllowed("localhost", []), true);
    assert.equal(isHostAllowed("evil.example.com", []), true); // empty list cannot enforce
    assert.equal(isHostAllowed("evil.example.com", ["node.ts.net"]), false);
    assert.equal(isHostAllowed("node.ts.net", ["node.ts.net"]), true);
    assert.equal(isHostAllowed("node.ts.net:8443", ["node.ts.net"]), true);
    assert.equal(isHostAllowed("10.20.30.40:47600", ["10.20.30.40"]), true);
    assert.equal(isHostAllowed("10.20.30.40:47600", ["10.20.30.41"]), false);
    assert.equal(isHostAllowed("proxy.internal:47600", ["proxy.internal:47600"]), true);
    assert.equal(isHostAllowed(undefined, ["node.ts.net"]), false);
});
