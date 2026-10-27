import test from "node:test";
import assert from "node:assert/strict";
import type { SessionInfo } from "../adapters/types";
import { restoreOrStart } from "../ui/surfaceDialoguesStartup";
import type { SurfaceDialoguesDeps } from "../ui/surfaceDialoguesTypes";

function makeDeps(
    getSession?: (backend: string, sessionId: string) => SessionInfo | undefined,
): SurfaceDialoguesDeps {
    return {
        deps: {
            adapterByBackend: new Map(),
            lastActive: {
                get: () => ({ backend: "claude", sessionId: "last" }),
            },
            getSession,
            // Restore must never reach for the all-backend scan.
            listSessions: () => Promise.reject(new Error("restore must not scan all backends")),
        },
    } as unknown as SurfaceDialoguesDeps;
}

test("restoreOrStart restores the last session through the direct lookup", () => {
    const info: SessionInfo = {
        backend: "claude",
        sessionId: "last",
        title: "Restored",
        updatedAt: new Date(0),
    };
    let opened: SessionInfo | undefined;
    let defaults = 0;

    restoreOrStart(makeDeps(() => info), (i) => (opened = i), () => (defaults += 1));

    assert.deepEqual(opened, info);
    assert.equal(defaults, 0);
});

test("restoreOrStart falls back to the default dialogue when the lookup misses", () => {
    let defaults = 0;
    let opened = 0;

    restoreOrStart(makeDeps(() => undefined), () => (opened += 1), () => (defaults += 1));

    assert.equal(opened, 0);
    assert.equal(defaults, 1);
});

test("restoreOrStart starts the default dialogue when no last session exists", () => {
    const deps = {
        deps: { adapterByBackend: new Map(), lastActive: { get: () => undefined } },
    } as unknown as SurfaceDialoguesDeps;
    let defaults = 0;

    restoreOrStart(deps, () => assert.fail("nothing to open"), () => (defaults += 1));

    assert.equal(defaults, 1);
});
