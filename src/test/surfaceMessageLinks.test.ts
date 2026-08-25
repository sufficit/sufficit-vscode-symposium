import { test } from "node:test";
import assert from "node:assert/strict";
import * as vscode from "vscode";
import { openExternalSurfaceLink } from "../ui/surfaceMessageLinks";

test("surface link handler delegates approved URLs to VS Code and rejects unsafe schemes", async () => {
    const opened: string[] = [];
    const env = vscode.env as typeof vscode.env & {
        openExternal: (uri: vscode.Uri) => Promise<boolean>;
    };
    const previous = env.openExternal;
    env.openExternal = (uri) => {
        opened.push(uri.toString());
        return Promise.resolve(true);
    };
    try {
        await openExternalSurfaceLink(" https://localhost:26508/path ");
        await openExternalSurfaceLink("mailto:user@example.com");
        await openExternalSurfaceLink("javascript:alert(1)");
        await openExternalSurfaceLink(123);
        assert.deepEqual(opened, ["https://localhost:26508/path", "mailto:user@example.com"]);
    } finally {
        if (previous) env.openExternal = previous;
        else delete (env as { openExternal?: unknown }).openExternal;
    }
});
