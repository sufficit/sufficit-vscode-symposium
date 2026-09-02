import test from "node:test";
import assert from "node:assert/strict";
import { editResend, retryLastMessage } from "../ui/surfaceBranching";
import type { SurfaceDialoguesDeps } from "../ui/surfaceDialogues";
import type { WebviewToHost } from "../protocol/chat";

function depsFor(
    controller: () => Record<string, unknown>,
    dispatchAhp: (message: WebviewToHost) => boolean = () => true,
): SurfaceDialoguesDeps {
    return {
        getController: () => controller(),
        post: () => undefined,
        dispatchAhp,
    } as unknown as SurfaceDialoguesDeps;
}

test("plain retry resends the interrupted message with its timeout reason", () => {
    let handled: WebviewToHost | undefined;
    const posted: unknown[] = [];
    const controller = {
        transcriptMessages: () => [{ role: "user", text: "run the complete build" }],
    };
    const deps = {
        getController: () => controller,
        post: (message: unknown) => {
            posted.push(message);
        },
        dispatchAhp: (message: WebviewToHost) => {
            handled = message;
            return true;
        },
    } as unknown as SurfaceDialoguesDeps;
    const reason = "Turn ended automatically: no activity from the agent for 5 minutes.";

    retryLastMessage(deps, 0, reason);

    assert.equal(handled?.type, "send");
    assert.equal(handled?.text, "run the complete build");
    assert.equal(handled?.interruptedBy, reason);
    assert.equal(handled?.retryOf, "retry");
    assert.deepEqual(posted, [
        {
            type: "event",
            event: {
                kind: "status-notice",
                text: `Retrying; no user message. Reason: ${reason}`,
                anchorIndex: 0,
            },
        },
    ]);
});

test("plain retry never promotes a provider maintenance page into chat or agent context", () => {
    let handled: WebviewToHost | undefined;
    const posted: unknown[] = [];
    const deps = {
        getController: () => ({
            transcriptMessages: () => [{ role: "user", text: "continue deployment" }],
        }),
        post: (message: unknown) => posted.push(message),
        dispatchAhp: (message: WebviewToHost) => {
            handled = message;
            return true;
        },
    } as unknown as SurfaceDialoguesDeps;
    const maintenancePage =
        "HTTP 503 Service Unavailable <!doctype html><html><head><style>body { color: red; }</style></head><body>maintenance</body></html>";

    retryLastMessage(deps, 0, maintenancePage);

    assert.equal(handled?.type, "send");
    assert.equal(handled?.interruptedBy, "HTTP 503 Service Unavailable");
    assert.doesNotMatch(JSON.stringify(posted), /doctype|<html|<style|color: red/i);
    assert.match(JSON.stringify(posted), /HTTP 503 Service Unavailable/);
});

test("plain retry survives AHP row-index drift by matching the visible user text", () => {
    let handled: WebviewToHost | undefined;
    const posted: unknown[] = [];
    const controller = {
        transcriptMessages: () => [
            { role: "assistant", text: "older projected row" },
            { role: "user", text: "retry this exact request" },
            { role: "assistant", text: "failed response" },
        ],
    };
    const deps = {
        getController: () => controller,
        post: (message: unknown) => posted.push(message),
        dispatchAhp: (message: WebviewToHost) => {
            handled = message;
            return true;
        },
    } as unknown as SurfaceDialoguesDeps;

    retryLastMessage(deps, 0, "stalled", "retry this exact request");

    assert.equal(handled?.type, "send");
    assert.equal(handled?.text, "retry this exact request");
    assert.equal(handled?.retryOf, "retry");
    assert.deepEqual(posted, [
        {
            type: "event",
            event: {
                kind: "status-notice",
                text: "Retrying; no user message. Reason: stalled",
                anchorIndex: 1,
            },
        },
    ]);
});

test("editResend retries unchanged Claude text in the same session", () => {
    let opened = 0;
    let handled: WebviewToHost | undefined;
    const controller = {
        backend: "claude",
        cwd: "/repo",
        title: "Deploy",
        transcriptMessages: () => [{ role: "user", text: "deploy now" }],
    };

    editResend(
        depsFor(
            () => controller,
            (message) => {
                handled = message;
                return true;
            },
        ),
        () => {
            opened++;
        },
        0,
        {
            type: "send",
            text: "deploy now",
            editFrom: 0,
        },
    );

    assert.equal(opened, 0);
    assert.equal(handled?.type, "send");
    assert.equal(handled?.text, "deploy now");
    assert.equal(handled?.editFrom, undefined);
});

test("editResend branches Claude when edited text changed", () => {
    let opened = 0;
    let oldHandled = 0;
    let newHandled = 0;
    const oldController = {
        backend: "claude",
        cwd: "/repo",
        title: "Deploy",
        transcriptMessages: () => [{ role: "user", text: "deploy now" }],
        transcriptMessagesUpTo: () => [],
        transcriptUpTo: () => undefined,
    };
    const newController = {};
    let current = oldController;

    editResend(
        depsFor(
            () => current,
            () => {
                if (current === oldController) oldHandled++;
                else newHandled++;
                return true;
            },
        ),
        () => {
            opened++;
            current = newController as typeof oldController;
        },
        0,
        {
            type: "send",
            text: "deploy endpoints",
            editFrom: 0,
        },
    );

    assert.equal(opened, 1);
    assert.equal(oldHandled, 0);
    assert.equal(newHandled, 1);
});

test("editResend keeps a Codex branch in its parent conversation lineage", () => {
    const parentId = "019f86c6-755f-7df2-8fa7-85d55d2b248d";
    let openedOptions: { lineageId?: string; seedHistory?: string } | undefined;
    const oldController = {
        backend: "codex",
        sessionId: parentId,
        lineageId: undefined,
        cwd: "/repo",
        title: "Parent conversation",
        transcriptMessages: () => [
            { role: "user", text: "first question" },
            { role: "assistant", text: "first answer" },
            { role: "user", text: "original text" },
        ],
        transcriptMessagesUpTo: () => [
            { role: "user", text: "first question" },
            { role: "assistant", text: "first answer" },
        ],
        transcriptUpTo: () => "user: first question\n\nassistant: first answer",
    };
    const newController = {};
    let current: Record<string, unknown> = oldController;

    editResend(
        depsFor(() => current),
        (_backend, options) => {
            openedOptions = options;
            current = newController;
        },
        2,
        { type: "send", text: "edited text", editFrom: 2 },
    );

    assert.equal(openedOptions?.lineageId, parentId);
    assert.match(openedOptions?.seedHistory ?? "", new RegExp(`Parent session: ${parentId}`));
    assert.match(openedOptions?.seedHistory ?? "", new RegExp(`lineage: ${parentId}`));
    assert.match(openedOptions?.seedHistory ?? "", /user: first question/);
});

test("editResend preserves the root lineage when branching an existing branch", () => {
    const rootId = "019f86c6-755f-7df2-8fa7-85d55d2b248d";
    let lineageId: string | undefined;
    const controller = {
        backend: "codex",
        sessionId: "019f8ae6-6ce1-7752-b2b5-023c94d63fbc",
        lineageId: rootId,
        cwd: "/repo",
        title: "Branch",
        transcriptMessages: () => [{ role: "user", text: "old" }],
        transcriptMessagesUpTo: () => [],
        transcriptUpTo: () => undefined,
    };

    editResend(
        depsFor(() => controller),
        (_backend, options) => {
            lineageId = options.lineageId;
        },
        0,
        {
            type: "send",
            text: "new",
            editFrom: 0,
        },
    );

    assert.equal(lineageId, rootId);
});
