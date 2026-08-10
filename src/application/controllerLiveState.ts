import type { SessionTerminalStatus, TodoItem } from "../adapters/types";
import type { PendingMessage } from "./controllerQueue";
import { ControllerEventHandler } from "./controllerEventHandler";
import type { TrackingMode } from "./outboundPrompt";

interface ControllerLiveStateDeps {
    armWatchdog(): void;
    clearWatchdog(): void;
    emit(message: unknown): void;
    statusChanged(): void;
    recordChanged(file: string, added?: number, removed?: number): void;
    takeQueued(): PendingMessage | undefined;
    emitQueue(): void;
    dispatch(message: PendingMessage): void;
}

/** Mutable turn state plus its provider-event reducer, kept out of the facade. */
export class ControllerLiveState {
    busy = false;
    attentionStatus: SessionTerminalStatus | undefined;
    firstTitle = "";
    todos: TodoItem[] = [];
    trackingMode: TrackingMode | undefined;
    lastLogicalTurnId: string | undefined;
    readonly eventHandler: ControllerEventHandler;

    constructor(deps: ControllerLiveStateDeps) {
        this.eventHandler = new ControllerEventHandler({
            isBusy: () => this.busy,
            setBusy: (busy) => {
                this.busy = busy;
            },
            armWatchdog: deps.armWatchdog,
            clearWatchdog: deps.clearWatchdog,
            emit: deps.emit,
            statusChanged: deps.statusChanged,
            recordChanged: deps.recordChanged,
            setTodos: (todos) => {
                this.todos = todos;
            },
            trackingMode: () => this.trackingMode,
            markTurnFailed: () => {
                this.attentionStatus = "error";
            },
            markTurnWarning: () => {
                this.attentionStatus = "warning";
            },
            turnFailed: () => this.attentionStatus === "error",
            setLogicalTurnId: (id) => {
                this.lastLogicalTurnId = id;
            },
            takeQueued: deps.takeQueued,
            emitQueue: deps.emitQueue,
            dispatch: deps.dispatch,
        });
    }
}
