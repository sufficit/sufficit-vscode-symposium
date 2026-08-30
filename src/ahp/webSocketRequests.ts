import { fileURLToPath } from "url";
import type { URI } from "@microsoft/agent-host-protocol";
import { isCwdAllowed, type BridgePolicy } from "../api/bridgePolicy";
import type { SymposiumApi } from "../api/symposiumApi";
import { AHP_ROOT_URI, parseAhpUri } from "./channelUris";
import { routeAhpClientAction } from "./clientActionRouter";
import type { AhpHostRuntime } from "./hostRuntime";
import { AHP_RPC_ERRORS, asRecord, type AhpWireMessage } from "./wireProtocol";

export interface AhpWebSocketLimits {
    maxFrameBytes?: number;
    maxConnections?: number;
    maxSubscriptions?: number;
    maxQueuedBytes?: number;
    maxMalformedFrames?: number;
    maxRequestsPerSecond?: number;
    maxConnectionsPerMinute?: number;
}

export type AhpRequestOutcome =
    | { ok: true; result: unknown }
    | { ok: false; code: number; message: string; data?: unknown };

interface SessionRequestContext {
    runtime: AhpHostRuntime;
    api: SymposiumApi;
    policy: BridgePolicy;
    syncRuntime?: () => void;
}

export function listSessions(runtime: AhpHostRuntime, message: AhpWireMessage): AhpRequestOutcome {
    if (message.params.channel !== AHP_ROOT_URI) {
        return rejected(AHP_RPC_ERRORS.invalidParams, "listSessions targets root");
    }
    const limit = boundedLimit(message.params.limit, 100);
    const offset = decodeCursor(message.params.cursor);
    if (offset === undefined) return rejected(AHP_RPC_ERRORS.invalidParams, "invalid cursor");
    const sessions = runtime.listSessions();
    const items = sessions.slice(offset, offset + limit);
    const next = offset + items.length;
    return accepted({
        items,
        ...(next < sessions.length ? { nextCursor: encodeCursor(next) } : {}),
    });
}

export async function createSession(
    context: SessionRequestContext,
    message: AhpWireMessage,
): Promise<AhpRequestOutcome> {
    const provider = message.params.provider;
    const channel = message.params.channel;
    const cwd = workingDirectory(message.params.workingDirectory);
    if (typeof provider !== "string" || typeof channel !== "string" || !cwd) {
        return rejected(
            AHP_RPC_ERRORS.invalidParams,
            "provider, session channel and workingDirectory are required",
        );
    }
    try {
        if (parseAhpUri(channel).kind !== "session") throw new Error("not a session URI");
    } catch {
        return rejected(AHP_RPC_ERRORS.invalidParams, "invalid session channel");
    }
    if (!isCwdAllowed(cwd, context.policy.allowedRoots)) {
        return rejected(AHP_RPC_ERRORS.permissionDenied, "working directory is not allowed");
    }
    const config = asRecord(message.params.config);
    const id = await context.api.sessions.create(provider, {
        cwd,
        model: typeof config.model === "string" ? config.model : undefined,
        permission: context.policy.sessionPermission,
    });
    if (!id) return rejected(AHP_RPC_ERRORS.providerNotFound, "provider not found");
    context.syncRuntime?.();
    return accepted(null);
}

export function disposeSession(
    context: SessionRequestContext,
    message: AhpWireMessage,
): AhpRequestOutcome {
    const channel = message.params.channel;
    const handle =
        typeof channel === "string" ? context.runtime.sessionByResource(channel as URI) : undefined;
    if (!handle || !context.api.sessions.dispose(handle.nativeSessionId)) {
        return rejected(AHP_RPC_ERRORS.sessionNotFound, "session not found");
    }
    context.syncRuntime?.();
    return accepted(null);
}

export function dispatchClientAction(
    context: Pick<SessionRequestContext, "runtime" | "api">,
    clientId: string,
    params: Record<string, unknown>,
): void {
    const resource = params.channel;
    const clientSeq = params.clientSeq;
    const action = asRecord(params.action);
    if (
        typeof resource !== "string" ||
        !Number.isSafeInteger(clientSeq) ||
        typeof action.type !== "string" ||
        !context.runtime.store.has(resource as URI)
    ) {
        return;
    }
    const rejectionReason = routeAhpClientAction(
        context.runtime,
        context.api,
        resource as URI,
        action,
    );
    context.runtime.dispatch(resource as URI, action, {
        origin: { clientId, clientSeq: clientSeq as number },
        rejectionReason,
    });
}

export function resolveLimits(input: AhpWebSocketLimits = {}): Required<AhpWebSocketLimits> {
    return {
        maxFrameBytes: positive(input.maxFrameBytes, 256 * 1024),
        maxConnections: positive(input.maxConnections, 32),
        maxSubscriptions: positive(input.maxSubscriptions, 64),
        maxQueuedBytes: positive(input.maxQueuedBytes, 1024 * 1024),
        maxMalformedFrames: positive(input.maxMalformedFrames, 3),
        maxRequestsPerSecond: positive(input.maxRequestsPerSecond, 100),
        maxConnectionsPerMinute: positive(input.maxConnectionsPerMinute, 60),
    };
}

function workingDirectory(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    try {
        return value.startsWith("file:") ? fileURLToPath(value) : value;
    } catch {
        return undefined;
    }
}

function boundedLimit(value: unknown, maximum: number): number {
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0
        ? Math.min(value, maximum)
        : maximum;
}

function encodeCursor(offset: number): string {
    return Buffer.from(String(offset)).toString("base64url");
}

function decodeCursor(value: unknown): number | undefined {
    if (value === undefined) return 0;
    if (typeof value !== "string") return undefined;
    const parsed = Number(Buffer.from(value, "base64url").toString("utf8"));
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function positive(value: number | undefined, fallback: number): number {
    return Number.isSafeInteger(value) && (value ?? 0) > 0 ? (value as number) : fallback;
}

function accepted(result: unknown): AhpRequestOutcome {
    return { ok: true, result };
}

function rejected(code: number, message: string, data?: unknown): AhpRequestOutcome {
    return { ok: false, code, message, data };
}
