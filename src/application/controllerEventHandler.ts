/** Normalized adapter-event handling for the application layer. */
import type { AgentEvent, TodoItem } from "../adapters/types";
import { parseTodoFence } from "../adapters/todos";
import type { TrackingMode } from "./outboundPrompt";
import type { PendingMessage } from "./controllerQueue";

export interface ControllerEventBindings {
    isBusy: () => boolean;
    setBusy: (busy: boolean) => void;
    armWatchdog: () => void;
    clearWatchdog: () => void;
    emit: (message: unknown) => void;
    statusChanged: () => void;
    recordChanged: (path: string, added?: number, removed?: number) => void;
    setTodos: (todos: TodoItem[]) => void;
    trackingMode: () => TrackingMode | undefined;
    markTurnFailed: () => void;
    markTurnWarning: () => void;
    setLogicalTurnId: (id: string) => void;
    takeQueued: () => PendingMessage | undefined;
    emitQueue: () => void;
    dispatch: (message: PendingMessage) => void;
    turnFailed: () => boolean;
}

/** Applies normalized adapter events to the controller-owned session state. */
export class ControllerEventHandler {
    constructor(private readonly bindings: ControllerEventBindings) {}

    readonly handle = (event: AgentEvent): void => {
        const b = this.bindings;
        if (b.isBusy()) {
            b.armWatchdog();
        }
        b.emit({ type: "event", event });
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
        if (event.kind === "error" && event.fatal !== false) {
            b.markTurnFailed();
        }
        if (event.kind === "status-notice" && event.terminal && event.severity === "warning") {
            b.markTurnWarning();
        }
        if (event.kind === "turn-start") {
            b.setLogicalTurnId(event.logicalTurnId);
        }
        if (event.kind !== "turn-end") {
            return;
        }
        b.setBusy(false);
        b.clearWatchdog();
        b.statusChanged();
        if (b.turnFailed()) {
            return;
        }
        const next = b.takeQueued();
        if (next) {
            b.emitQueue();
            b.dispatch(next);
        }
    };
}
