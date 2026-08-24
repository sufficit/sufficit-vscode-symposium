import type { InjectedUserMessage, InjectionDropReason } from "../types";
import type { TurnRunnerDeps } from "./turnRunnerDeps";
import type { ChatMessage } from "./types";
import { buildImageParts } from "./imageParts";

export const STEER_NOTE =
    "[Mid-turn steer] The user sent the following while you were still working. " +
    "Treat it as the latest instruction and adapt your current plan to it. Do not " +
    "restart from scratch and do not repeat tool calls you already completed in this turn.";

/**
 * A user message may only be spliced where every assistant `tool_calls` entry
 * already has its matching `tool` replies. The last message being a completed
 * tool reply is exactly that point — and it also implies the loop is mid-tool,
 * so another hop is genuinely coming.
 */
export function canSpliceUserMessage(messages: readonly ChatMessage[]): boolean {
    return messages[messages.length - 1]?.role === "tool";
}

export class TurnInjectionQueue {
    private generation = 0;
    private accepting = false;
    private readonly pending: InjectedUserMessage[] = [];

    /**
     * Opens the window for one run. The returned close() releases anything never
     * spliced; it is a no-op once a newer run has opened its own window.
     */
    open(): (reason: InjectionDropReason) => void {
        this.drainAndDrop("superseded");
        const generation = ++this.generation;
        this.accepting = true;
        return (reason) => {
            if (generation !== this.generation) {
                return;
            }
            this.accepting = false;
            this.drainAndDrop(reason);
        };
    }

    /** Router-facing. False = no live window; the caller falls back to the queue. */
    offer(message: InjectedUserMessage): boolean {
        if (!this.accepting) {
            return false;
        }
        this.pending.push(message);
        return true;
    }

    /** Removes and returns everything pending. Only called at a splice point. */
    take(): InjectedUserMessage[] {
        return this.pending.splice(0, this.pending.length);
    }

    /** Releases everything pending regardless of generation (session disposal). */
    closeAll(reason: InjectionDropReason): void {
        this.accepting = false;
        this.drainAndDrop(reason);
    }

    // Drops last-to-first: the controller re-queues each with unshift(), so
    // reverse order is what restores the original sequence at the queue head.
    private drainAndDrop(reason: InjectionDropReason): void {
        for (const item of this.pending.splice(0, this.pending.length).reverse()) {
            item.onDropped?.(reason);
        }
    }
}

/** Splices pending injections at a tool-safe boundary. Returns how many landed. */
export function applyInjectedMessages(
    deps: TurnRunnerDeps,
    messages: ChatMessage[],
    logicalTurnId: string,
): number {
    const port = deps.injections;
    if (!port || !canSpliceUserMessage(messages)) {
        return 0;
    }
    const pending = port.take();
    if (!pending.length) {
        return 0;
    }
    const role = deps.cfg.supportsDeveloperRole !== false ? "developer" : "system";
    for (const item of pending) {
        // Everything the model does from here serves the new instruction, so
        // later ledger rows carry the new intent id.
        deps.setIntentId?.(item.intentId);
        messages.push({ role, content: STEER_NOTE });
        deps.led(role, STEER_NOTE, { kind: "steer-notice" });
        const parts = buildImageParts(item.images);
        messages.push({
            role: "user",
            content: parts.length ? [{ type: "text", text: item.text }, ...parts] : item.text,
        });
        deps.led(
            "user",
            parts.length ? `${item.text}\n[${parts.length} image(s) attached]` : item.text,
            { steer: true },
        );
        // A stale OBJECTIVE in the follow-up anchor would fight the steer.
        deps.setObjective?.(item.text);
        item.onCommitted?.(logicalTurnId);
    }
    deps.safePersist();
    return pending.length;
}
