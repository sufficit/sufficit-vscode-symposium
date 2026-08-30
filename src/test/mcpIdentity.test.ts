import { test } from "node:test";
import assert from "node:assert/strict";
import {
    SUFFICIT_IDENTITY_NATIVE_MCP_ID,
    SUFFICIT_NATIVE_MCP_ID,
    isSufficitBuiltinMcpIdentity,
    isSufficitIdentityNativeMcpIdentity,
    isSufficitNativeMcpIdentity,
} from "../config/mcpIdentity";

test("Sufficit native MCP identity collapses Claude and Codex name variants", () => {
    assert.equal(SUFFICIT_NATIVE_MCP_ID, "sufficit-ai");
    for (const name of ["Sufficit AI", "sufficit_ai", "sufficit-ai", "SUFFICITAI"]) {
        assert.equal(isSufficitNativeMcpIdentity(name), true);
    }
    assert.equal(isSufficitNativeMcpIdentity("sufficit-memory"), false);
    assert.equal(isSufficitNativeMcpIdentity(undefined), false);
});

test("Sufficit Identity remains distinct while all aliases collapse", () => {
    assert.equal(SUFFICIT_IDENTITY_NATIVE_MCP_ID, "sufficit-identity");
    for (const name of ["Sufficit Identity", "sufficit_identity", "sufficit-identity"]) {
        assert.equal(isSufficitIdentityNativeMcpIdentity(name), true);
        assert.equal(isSufficitBuiltinMcpIdentity(name), true);
        assert.equal(isSufficitNativeMcpIdentity(name), false);
    }
    assert.equal(isSufficitBuiltinMcpIdentity("sufficit-memory"), false);
});
