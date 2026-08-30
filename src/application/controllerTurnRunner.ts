/** Turn lifecycle owner: starting a turn (dispatch), ending one outside the
 *  adapter-event reducer (completion) and the silence watchdog that force-ends
 *  a stalled one.
 *
 * Extracted from ChatController as a collaborator over a context bag. The three
 * concerns live together because they are one cycle over the same collaborators
 * — the controller used to rebuild three overlapping context bags for them, and
 * every turn-termination path still routes through `completeTurn`
 * (controllerTurnCompletion.ts).
 */
import type { AgentAdapter, AgentSession, SessionStartOptions } from "../adapters/types";
import type { HubClient } from "../sync/hubClient";
import { dispatchControllerMessage } from "./controllerDispatch";
import type { HubState } from "./controllerHubState";
import type { ControllerLiveState } from "./controllerLiveState";
import type { ChatQueue, PendingMessage, QueueDispatchOptions } from "./controllerQueue";
import { completeTurn, type TurnCompletionContext } from "./controllerTurnCompletion";
import {
    WatchdogContext,
    armWatchdog as armWatchdogFn,
    clearWatchdog as clearWatchdogFn,
} from "./controllerWatchdog";
import type { OutboundPromptState } from "./outboundPrompt";
import type { ApplicationPorts } from "./ports";
import type { TurnOrigin } from "./turn";

interface ControllerTurnRunnerDeps {
    adapter: AgentAdapter;
    options: SessionStartOptions;
    ports: ApplicationPorts;
    hub: HubClient;
    hubState: HubState;
    promptState: OutboundPromptState;
    live: ControllerLiveState;
    queue: ChatQueue;
    sessionId(): string | undefined;
    getSession(): AgentSession | undefined;
    setSession(session: AgentSession): void;
    reloadGuardrails(): Promise<void>;
    reloadTasks(): Promise<void>;
    checkpointId(): string | undefined;
    setCheckpointId(id: string | undefined): void;
    aiToolsInfo(): { available: string[]; enabled: string[] } | undefined;
    pendingTasksSummary(): string | undefined;
    emit(message: unknown): void;
    emitQueue(): void;
    statusChanged(): void;
    releaseOwnership(): void;
    log(message: string): void;
}

/** id is assigned only by ChatQueue.enqueue — its presence means this
 *  message spent time in the queue before reaching dispatch(). */
export function turnOriginOf(
    message: Pick<PendingMessage, "retryOf" | "interruptedBy" | "id">,
): TurnOrigin {
    // `interruptedBy` is retained as a second marker because a retry may cross
    // a client/reload boundary where attribution metadata is unavailable.
    if (message.retryOf !== undefined || message.interruptedBy !== undefined) return "retry";
    if (message.id != null) return "queue";
    return "user";
}

export class ControllerTurnRunner {
    // Force-ends a silent turn that would otherwise stay working forever.
    private readonly watchdogState = {
        timer: undefined as ReturnType<typeof setTimeout> | undefined,
    };

    constructor(private readonly deps: ControllerTurnRunnerDeps) {}

    /** Whether a silence watchdog is currently pending — a controller
     *  reattached while busy needs one rearmed. */
    get watching(): boolean {
        return !!this.watchdogState.timer;
    }

    armWatchdog(): void {
        armWatchdogFn(this.watchdogContext(), this.watchdogState);
    }

    clearWatchdog(): void {
        clearWatchdogFn(this.watchdogState);
    }

    dispatch(message: PendingMessage, options: QueueDispatchOptions = {}): Promise<void> {
        // Promoting or retrying explicitly releases a prior failure hold. A
        // new direct request may opt to run beside that paused work instead.
        if (!options.preserveQueueHold) this.deps.queue.release();
        // A retry is a new backend attempt. `retryOf` remains attribution
        // metadata, but reusing the old backend id lets a late cancel/turn-end
        // from the stalled attempt terminate the retry as well.
        const turn = this.deps.live.turns.begin(turnOriginOf(message), {
            intentId: message.intentId,
        });
        // Start from the user's explicit dispatch, not from the previous
        // attempt's deadline or from the first provider event. This resets the
        // retry clock immediately, including slow adapter startup.
        this.armWatchdog();
        return dispatchControllerMessage(message, {
            adapter: this.deps.adapter,
            options: this.deps.options,
            ports: this.deps.ports,
            hub: this.deps.hub,
            hubState: this.deps.hubState,
            promptState: this.deps.promptState,
            sessionId: this.deps.sessionId,
            getSession: this.deps.getSession,
            setSession: this.deps.setSession,
            onSessionEvent: this.deps.live.eventHandler.handle,
            reloadGuardrails: this.deps.reloadGuardrails,
            reloadTasks: this.deps.reloadTasks,
            checkpointId: this.deps.checkpointId,
            setCheckpointId: this.deps.setCheckpointId,
            aiToolsInfo: this.deps.aiToolsInfo,
            pendingTasksSummary: this.deps.pendingTasksSummary,
            setTrackingMode: (mode) => {
                this.deps.live.trackingMode = mode;
            },
            hasFirstTitle: () => !!this.deps.live.firstTitle,
            setFirstTitle: (title) => {
                this.deps.live.firstTitle = title;
            },
            armWatchdog: () => this.armWatchdog(),
            statusChanged: this.deps.statusChanged,
            emit: this.deps.emit,
            turn,
            completion: this.completionContext(),
        });
    }

    /** Shared by the watchdog and dispatch's catch path — every way a turn
     *  can end outside the adapter-event reducer routes through here. */
    completionContext(): TurnCompletionContext {
        return {
            turns: this.deps.live.turns,
            clearWatchdog: () => this.clearWatchdog(),
            statusChanged: this.deps.statusChanged,
            emit: this.deps.emit,
            takeQueued: () => (this.deps.queue.isHeld ? undefined : this.deps.queue.shift()),
            emitQueue: this.deps.emitQueue,
            dispatch: (message) => void this.dispatch(message),
            holdQueue: (hold) => this.deps.queue.hold(hold),
            queuedCount: () => this.deps.queue.length,
            releaseOwnership: this.deps.releaseOwnership,
            log: this.deps.log,
        };
    }

    private watchdogContext(): WatchdogContext {
        return {
            turns: this.deps.live.turns,
            completeTurn: (turn, outcome) =>
                completeTurn(turn, this.completionContext(), { outcome, emitTurnEnd: true }),
            cancel: () => this.deps.getSession()?.cancel(),
            emit: this.deps.emit,
            silenceMinutes: () =>
                this.deps.ports.configuration.get("symposium", "turnSilenceMinutes", 5),
            retrySilenceMinutes: () =>
                this.deps.ports.configuration.get("symposium", "turnRetrySilenceMinutes", 15),
        };
    }
}
