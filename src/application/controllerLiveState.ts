import type { TodoItem } from "../adapters/types";
import type { PendingMessage, QueueHold } from "./controllerQueue";
import { ControllerEventHandler } from "./controllerEventHandler";
import type { TrackingMode } from "./outboundPrompt";
import { TurnTracker } from "./turn";

interface ControllerLiveStateDeps {
    armWatchdog(): void;
    clearWatchdog(): void;
    emit(message: unknown): void;
    statusChanged(): void;
    recordChanged(file: string, added?: number, removed?: number): void;
    takeQueued(): PendingMessage | undefined;
    emitQueue(): void;
    dispatch(message: PendingMessage): void;
    holdQueue(hold: QueueHold): void;
    queuedCount(): number;
    log?(message: string): void;
}

/** Mutable turn state plus its provider-event reducer, kept out of the facade.
 *  `busy`/`attentionStatus`/`lastLogicalTurnId` are derived from `turns`
 *  (see turn.ts) rather than stored directly — see that file for why. */
export class ControllerLiveState {
    firstTitle = "";
    todos: TodoItem[] = [];
    trackingMode: TrackingMode | undefined;
    readonly turns: TurnTracker;
    readonly eventHandler: ControllerEventHandler;

    constructor(deps: ControllerLiveStateDeps) {
        this.turns = new TurnTracker({ log: deps.log });
        this.eventHandler = new ControllerEventHandler({
            turns: this.turns,
            armWatchdog: deps.armWatchdog,
            clearWatchdog: deps.clearWatchdog,
            emit: deps.emit,
            statusChanged: deps.statusChanged,
            recordChanged: deps.recordChanged,
            setTodos: (todos) => {
                this.todos = todos;
            },
            trackingMode: () => this.trackingMode,
            takeQueued: deps.takeQueued,
            emitQueue: deps.emitQueue,
            dispatch: deps.dispatch,
            holdQueue: deps.holdQueue,
            queuedCount: deps.queuedCount,
            log: deps.log,
        });
    }

    get busy(): boolean {
        return this.turns.isBusy;
    }

    get attentionStatus() {
        return this.turns.attention;
    }

    get lastLogicalTurnId(): string | undefined {
        return this.turns.lastBackendTurnId;
    }
}
