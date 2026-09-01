import assert from "node:assert/strict";
import test from "node:test";
import { handleSurfaceCommandMessage } from "../ui/surfaceMessageCommands";
import type { SurfaceMessagesDeps } from "../ui/surfaceMessagesTypes";

test("permission picker updates the live controller immediately", async () => {
    let effective = "manager";
    const handled = await handleSurfaceCommandMessage(
        { type: "set-permission", permission: "admin" },
        {
            getController: () => ({
                setPermission: (permission: string) => {
                    effective = permission;
                },
                getPermission: () => effective,
            }),
        } as unknown as SurfaceMessagesDeps,
    );

    assert.equal(handled, true);
    assert.equal(effective, "admin");
});
