import assert from "node:assert/strict";
import test from "node:test";
import * as vscode from "vscode";
import { handleSurfaceCommandMessage } from "../ui/surfaceMessageCommands";
import type { SurfaceMessagesDeps } from "../ui/surfaceMessagesTypes";

test("clipboard bridge reports success only after VS Code writes and reports failures", async () => {
    const env = vscode.env as unknown as { clipboard?: { writeText(text: string): Promise<void> } };
    const original = env.clipboard;
    const replies: unknown[] = [];
    const deps = {
        post: (message: unknown) => replies.push(message),
    } as unknown as SurfaceMessagesDeps;
    try {
        let copied = "";
        env.clipboard = {
            writeText: (text) => {
                copied = text;
                return Promise.resolve();
            },
        };
        await handleSurfaceCommandMessage(
            { type: "copy-text", id: "1", text: "selected text" },
            deps,
        );
        assert.equal(copied, "selected text");
        assert.deepEqual(replies.pop(), { type: "clipboard-result", id: "1", ok: true });
        env.clipboard.writeText = () => Promise.reject(new Error("denied"));
        await handleSurfaceCommandMessage(
            { type: "copy-text", id: "2", text: "secret text" },
            deps,
        );
        assert.deepEqual(replies.pop(), { type: "clipboard-result", id: "2", ok: false });
    } finally {
        env.clipboard = original;
    }
});
