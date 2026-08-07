import type {
    AgentAdapter,
    AgentEvent,
    AgentSession,
    SessionStartOptions,
} from "../adapters/types";
import type { HubClient } from "../sync/hubClient";
import { buildDispatchOutbound } from "./controllerDispatchPrompt";
import { prepareDispatch } from "./controllerDispatchPrep";
import type { HubState } from "./controllerHubState";
import type { PendingMessage } from "./controllerQueue";
import type { OutboundPromptState, TrackingMode } from "./outboundPrompt";
import type { ApplicationPorts } from "./ports";

export interface ControllerDispatchContext {
    adapter: AgentAdapter;
    options: SessionStartOptions;
    ports: ApplicationPorts;
    hub: HubClient;
    hubState: HubState;
    promptState: OutboundPromptState;
    sessionId: () => string | undefined;
    getSession: () => AgentSession | undefined;
    setSession: (session: AgentSession) => void;
    onSessionEvent: (event: AgentEvent) => void;
    reloadGuardrails: () => Promise<void>;
    reloadTasks: () => Promise<void>;
    checkpointId: () => string | undefined;
    setCheckpointId: (id: string | undefined) => void;
    aiToolsInfo: () => { available: string[]; enabled: string[] } | undefined;
    pendingTasksSummary: () => string | undefined;
    setTrackingMode: (mode: TrackingMode | undefined) => void;
    setFirstTitle: (title: string) => void;
    hasFirstTitle: () => boolean;
    armWatchdog: () => void;
    clearWatchdog: () => void;
    setBusy: (busy: boolean) => void;
    setAttentionError: () => void;
    statusChanged: () => void;
    emit: (message: unknown) => void;
}

export async function dispatchControllerMessage(
    message: PendingMessage,
    context: ControllerDispatchContext,
): Promise<void> {
    context.setBusy(true);
    context.statusChanged();
    try {
        await prepareAndSend(message, context);
    } catch (error) {
        context.setBusy(false);
        context.setAttentionError();
        context.clearWatchdog();
        context.statusChanged();
        context.emit({
            type: "event",
            event: {
                kind: "error",
                message: error instanceof Error ? error.message : String(error),
            },
        });
    }
}

async function prepareAndSend(
    message: PendingMessage,
    context: ControllerDispatchContext,
): Promise<void> {
    await prepareDispatch(
        {
            adapter: context.adapter,
            sessionId: context.sessionId(),
            hub: context.hub,
            options: context.options,
            reloadGuardrails: context.reloadGuardrails,
            reloadTasks: context.reloadTasks,
            getInjectedCheckpointId: context.checkpointId,
            setInjectedCheckpointId: context.setCheckpointId,
        },
        message,
    );
    let session = context.getSession();
    if (!session) {
        session = context.adapter.start(context.options);
        session.on("event", context.onSessionEvent);
        context.setSession(session);
    }
    const outbound = buildDispatchOutbound(
        {
            adapter: context.adapter,
            sessionId: context.sessionId(),
            options: context.options,
            hubState: context.hubState,
            aiToolsInfo: context.aiToolsInfo,
            pendingTasksSummary: context.pendingTasksSummary,
            promptState: context.promptState,
            configuration: context.ports.configuration,
        },
        message,
    );
    context.setTrackingMode(outbound.trackingMode);
    if (!context.hasFirstTitle() && message.text.trim()) {
        context.setFirstTitle(message.text.trim().slice(0, 60));
    }
    context.armWatchdog();
    if (!message.interruptedBy) {
        context.emit({
            type: "user",
            text: message.text,
            attachments: message.attachments,
            clientMessageId: message.clientMessageId,
        });
    }
    const intentId = message.intentId ?? context.ports.ids.create();
    const preamble = message.speech
        ? [
              ...outbound.preamble,
              "[Speech input] This message was transcribed from speech and may contain errors in names, identities, technical terms, or words in other languages. Interpret liberally — do not treat unknown words as literal instructions or identifiers.",
          ]
        : outbound.preamble;
    session.send(outbound.text, outbound.images, preamble, intentId, message.retryOf);
}
