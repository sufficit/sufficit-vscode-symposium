/** Normalized adapter-event handling for the application layer. */
import type { AgentEvent, TodoItem } from "../adapters/types";
import { parseTodoFence } from "../adapters/todos";
import type { TrackingMode } from "./outboundPrompt";
import { completeTurn, type TurnCompletionContext } from "./controllerTurnCompletion";
import { isResponseBlockingToolEvent, MISSING_FINAL_RESPONSE_NOTICE } from "./finalResponseState";

export interface ControllerEventBindings extends TurnCompletionContext {
    armWatchdog(): void;
    /** False defers the raw event while a controller-owned recovery is pending. */
    observeEvent?(event: AgentEvent): boolean;
    recordChanged(path: string, added?: number, removed?: number): void;
    setTodos(todos: TodoItem[]): void;
    trackingMode(): TrackingMode | undefined;
}

/** Applies normalized adapter events to the controller-owned session state. */
export class ControllerEventHandler {
    constructor(private readonly b: ControllerEventBindings) {}

    readonly handle = (event: AgentEvent): void => {
        const b = this.b;
        if (b.turns.isBusy) {
            b.armWatchdog();
        }
        // Turn boundaries are classified before they're forwarded — a
        // rejected (stale-id / no-live-turn) boundary is dropped rather than
        // emitted-then-ignored, so the render stream and every downstream
        // consumer (webview, subagents, AHP) only ever see turn-starts/ends
        // that genuinely belong to the turn that's live.
        if (event.kind === "turn-start") {
            this.onTurnStart(event);
            return;
        }
        if (event.kind === "turn-end") {
            this.onTurnEnd(event);
            return;
        }
        if (b.observeEvent?.(event) !== false) {
            b.emit({ type: "event", event });
        }
        this.applyEventSideEffects(event);
    };

    private onTurnStart(event: Extract<AgentEvent, { kind: "turn-start" }>): void {
        const b = this.b;
        const decision = b.turns.resolveStart(event.logicalTurnId);
        if (!decision.accept) {
            b.log?.(`[turn-start] dropped — ${decision.reason} (id=${event.logicalTurnId})`);
            return;
        }
        b.emit({ type: "event", event });
    }

    private onTurnEnd(event: Extract<AgentEvent, { kind: "turn-end" }>): void {
        const b = this.b;
        const decision = b.turns.resolveEnd(event.logicalTurnId);
        if (!decision.accept) {
            b.log?.(
                `[turn-end] dropped — ${decision.reason} (id=${event.logicalTurnId ?? "none"})`,
            );
            return;
        }
        // The emitter had no id of its own but the turn was already bound
        // (e.g. its turn-start carried one) — record it on the forwarded
        // event so the render log / AHP projection always know which turn
        // ended, even for emitters that don't thread the id through.
        const enriched: AgentEvent =
            !event.logicalTurnId && decision.turn.backendId
                ? { ...event, logicalTurnId: decision.turn.backendId }
                : event;
        if (
            decision.turn.awaitingFinalResponse &&
            !decision.turn.cancelRequested &&
            !decision.turn.attention
        ) {
            const notice: AgentEvent = {
                kind: "status-notice",
                severity: "warning",
                terminal: true,
                text: MISSING_FINAL_RESPONSE_NOTICE,
            };
            b.emit({ type: "event", event: notice });
            decision.turn.recordWarning();
        }
        b.emit({ type: "event", event: enriched });
        // false: this event IS the adapter's own turn-end; completeTurn must
        // not synthesize a second one.
        completeTurn(decision.turn, b, { emitTurnEnd: false });
    }

    private applyEventSideEffects(event: AgentEvent): void {
        const b = this.b;
        if (event.kind === "text" && event.text.trim()) {
            b.turns.current?.recordAssistantText();
        }
        if (isResponseBlockingToolEvent(event)) {
            b.turns.current?.recordToolActivity();
        }
        if (event.kind === "session") {
            b.statusChanged();
        }
        if (
            event.kind === "tool-start" &&
            event.path &&
            (event.added != null || event.removed != null)
        ) {
            b.recordChanged(event.path, event.added, event.removed);
        }
        if ((event.kind === "tool-start" || event.kind === "tool-end") && event.todos) {
            b.setTodos(event.todos);
        }
        if (event.kind === "text" && b.trackingMode() === "fence") {
            const todos = parseTodoFence(event.text);
            if (todos) {
                b.setTodos(todos);
                b.emit({
                    type: "event",
                    event: { kind: "tool-start", toolName: "TodoWrite", detail: "", todos },
                });
            }
        }
        // !historical: replaying a stored transcript containing a past fatal
        // error must not badge an otherwise-idle reopened session as errored.
        if (event.kind === "error" && event.fatal !== false && !event.historical) {
            (b.turns.current ?? b.turns.lastTurn)?.recordError();
        }
        if (event.kind === "status-notice" && event.terminal && event.severity === "warning") {
            (b.turns.current ?? b.turns.lastTurn)?.recordWarning();
        }
    }
}
