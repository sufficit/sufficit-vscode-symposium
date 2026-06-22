import * as vscode from "vscode";
import { WebviewToHost } from "./protocol";
import { ChatQueue, PendingMessage, SendMode } from "./controllerQueue";
import { RenderStream } from "./renderStream";

export interface ControllerMessageContext {
    busy(): boolean;
    cancel(): void;
    queue: ChatQueue;
    stream: RenderStream;
    emitQueue(): void;
    dispatch(message: PendingMessage): void;
    onSend(message: PendingMessage, mode: SendMode): void;
}

/** Handles webview-only commands for a live ChatController. */
export async function handleControllerMessage(message: WebviewToHost, ctx: ControllerMessageContext): Promise<boolean> {
    switch (message.type) {
        case "send":
            ctx.onSend(
                { text: message.text, attachments: message.attachments ?? [], model: message.model, reasoning: message.reasoning, permission: message.permission, autonomy: message.autonomy },
                (message.mode as SendMode) ?? "send",
            );
            return true;
        case "cancel":
            ctx.cancel();
            return true;
        case "queue-remove":
            if (ctx.queue.remove(message.id)) { ctx.emitQueue(); }
            return true;
        case "queue-edit": {
            const queued = ctx.queue.take(message.id);
            if (queued) {
                ctx.emitQueue();
                ctx.stream.toSink({ type: "load-input", text: queued.text, attachments: queued.attachments });
            }
            return true;
        }
        case "queue-promote": {
            const queued = ctx.queue.take(message.id);
            if (!queued) { return true; }
            if (ctx.busy()) {
                ctx.queue.unshift(queued);
                ctx.emitQueue();
                ctx.cancel();
            } else {
                ctx.emitQueue();
                ctx.dispatch(queued);
            }
            return true;
        }
        case "pick-attachments": {
            const picked = await vscode.window.showOpenDialog({
                canSelectMany: true,
                openLabel: "Attach",
                title: "Attach files to the message",
            });
            if (picked?.length) {
                ctx.stream.toSink({
                    type: "attachments-picked",
                    files: picked.map((uri) => ({
                        path: uri.fsPath,
                        name: uri.path.split("/").pop() ?? uri.fsPath,
                    })),
                });
            }
            return true;
        }
    }
    return false;
}
