import { test } from "node:test";
import assert from "node:assert/strict";

import { ensureSufficitNativeServers, type NativeMcpWriter } from "../config/nativeMcpServers";
import type { ServerManifest } from "../config/servers";

test("native MCP catalog keeps AI and Identity distinct and complete", () => {
    const manifests = new Map<string, ServerManifest>();
    const tools = new Map<string, string[]>();
    const writer: NativeMcpWriter = {
        writeManifest(name, manifest) {
            manifests.set(name, manifest);
        },
        writeServerItem(server, type, name, content) {
            assert.equal(type, "tools");
            assert.match(content, new RegExp(`server: ${server}`));
            tools.set(server, [...(tools.get(server) ?? []), name]);
        },
    };

    ensureSufficitNativeServers(writer);

    assert.deepEqual([...manifests.keys()].sort(), ["sufficit-ai", "sufficit-identity"]);
    assert.equal(manifests.get("sufficit-ai")?.builtin, true);
    assert.equal(manifests.get("sufficit-identity")?.transport, "builtin");
    assert.ok(tools.get("sufficit-ai")?.includes("memory_search"));
    assert.ok(tools.get("sufficit-ai")?.includes("memory_candidates"));
    assert.ok(tools.get("sufficit-ai")?.includes("memory_candidate_accept"));
    assert.ok(tools.get("sufficit-ai")?.includes("memory_candidate_reject"));
    assert.ok(tools.get("sufficit-identity")?.includes("vault_resolve"));
    assert.ok(tools.get("sufficit-identity")?.includes("me_session_revoke"));
});
