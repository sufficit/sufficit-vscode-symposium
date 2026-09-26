import assert from "node:assert/strict";
import test from "node:test";
import type { AgentAdapter, SessionStartOptions } from "../adapters/types";
import { BackendHandoff } from "../ui/backendHandoff";

test("a live dialogue handed to Genius carries bounded source context without a foreign lookup", () => {
    const parentId = "20e59bee-1722-4e90-bb2f-9ea1f4abc4cc";
    const source = `user: ${"old context ".repeat(2000)}\n\nassistant: Previous answer\n\nuser: Configure /invite by group contact`;
    let opened: { backend: string; options: SessionStartOptions } | undefined;
    let input: unknown;
    const handoff = new BackendHandoff({
        getAdapter: (backend) =>
            ({
                backend,
                displayName: backend === "genius" ? "Genius" : "Claude Code",
            }) as AgentAdapter,
        listSessions: () => Promise.resolve([]),
        cwdFor: () => "/workspace",
        openDialogue: (backend, options) => {
            opened = { backend, options };
        },
        post: (message) => {
            input = message;
        },
        getController: () => ({
            backend: "claude",
            title: "Group contacts",
            cwd: "/workspace",
            sessionId: parentId,
            transcript: () => source,
        }),
        getTerminalSession: () => undefined,
        getStore: () => ({ setParent: () => undefined }),
    });

    handoff.switch("genius");

    assert.equal(opened?.backend, "genius");
    assert.equal(opened?.options.parentId, parentId);
    assert.equal(opened?.options.handoff, undefined);
    assert.match(opened?.options.seedHistory ?? "", /Configure \/invite by group contact/);
    assert.ok((opened?.options.seedHistory?.length ?? 0) < 13_000);
    assert.doesNotMatch(opened?.options.seedHistory ?? "", /old context old context/);
    assert.deepEqual(input, {
        type: "set-input",
        text: "Continue the conversation using the transferred context.",
    });
});

test("other backends retain the source session reference for native handoffs", () => {
    const parentId = "20e59bee-1722-4e90-bb2f-9ea1f4abc4cc";
    let options: SessionStartOptions | undefined;
    const handoff = new BackendHandoff({
        getAdapter: (backend) => ({ backend, displayName: backend }) as AgentAdapter,
        listSessions: () => Promise.resolve([]),
        cwdFor: () => "/workspace",
        openDialogue: (_backend, value) => {
            options = value;
        },
        post: () => undefined,
        getController: () => ({
            backend: "claude",
            title: "Source",
            cwd: "/workspace",
            sessionId: parentId,
            transcript: () => "user: prior message",
        }),
        getTerminalSession: () => undefined,
        getStore: () => ({ setParent: () => undefined }),
    });

    handoff.switch("codex");

    assert.equal(options?.seedHistory, undefined);
    assert.deepEqual(options?.handoff, {
        sessionId: parentId,
        backend: "claude",
        title: "Source",
    });
});
