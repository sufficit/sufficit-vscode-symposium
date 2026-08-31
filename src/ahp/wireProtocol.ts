import { AHP_FEATURE_VERSION } from "./feature";

export const AHP_SUPPORTED_PROTOCOL_VERSIONS = [AHP_FEATURE_VERSION, "0.5.2", "0.5.1"] as const;

export const AHP_RPC_ERRORS = {
    parse: -32700,
    invalidRequest: -32600,
    methodNotFound: -32601,
    invalidParams: -32602,
    internal: -32603,
    sessionNotFound: -32001,
    providerNotFound: -32002,
    unsupportedVersion: -32005,
    permissionDenied: -32009,
} as const;

export interface AhpWireMessage {
    jsonrpc: "2.0";
    id?: number;
    method: string;
    params: Record<string, unknown>;
}

export type AhpWireParseResult =
    | { ok: true; message: AhpWireMessage }
    | { ok: false; code: number; message: string; id?: number };

const METHODS = new Set([
    "initialize",
    "ping",
    "reconnect",
    "subscribe",
    "unsubscribe",
    "createSession",
    "disposeSession",
    "listSessions",
    "dispatchAction",
]);

export function parseAhpWireMessage(payload: string, maxBytes: number): AhpWireParseResult {
    if (Buffer.byteLength(payload) > maxBytes) {
        return { ok: false, code: AHP_RPC_ERRORS.invalidRequest, message: "frame too large" };
    }
    let value: unknown;
    try {
        value = JSON.parse(payload);
    } catch {
        return { ok: false, code: AHP_RPC_ERRORS.parse, message: "invalid JSON" };
    }
    if (!isRecord(value) || value.jsonrpc !== "2.0") {
        return {
            ok: false,
            code: AHP_RPC_ERRORS.invalidRequest,
            message: "invalid JSON-RPC message",
        };
    }
    const id = value.id;
    if (id !== undefined && (!Number.isSafeInteger(id) || (id as number) < 0)) {
        return {
            ok: false,
            code: AHP_RPC_ERRORS.invalidRequest,
            message: "id must be a non-negative integer",
        };
    }
    if (typeof value.method !== "string" || !METHODS.has(value.method)) {
        return {
            ok: false,
            code: AHP_RPC_ERRORS.methodNotFound,
            message: `unsupported method: ${String(value.method)}`,
            id: id as number | undefined,
        };
    }
    if (!isRecord(value.params)) {
        return {
            ok: false,
            code: AHP_RPC_ERRORS.invalidParams,
            message: "params must be an object",
            id: id as number | undefined,
        };
    }
    const notification = value.method === "unsubscribe" || value.method === "dispatchAction";
    if (notification === (id !== undefined)) {
        return {
            ok: false,
            code: AHP_RPC_ERRORS.invalidRequest,
            message: notification ? "notification must not contain id" : "request id is required",
            id: id as number | undefined,
        };
    }
    return {
        ok: true,
        message: {
            jsonrpc: "2.0",
            id: id as number | undefined,
            method: value.method,
            params: value.params,
        },
    };
}

export function rpcResult(id: number, result: unknown): string {
    return JSON.stringify({ jsonrpc: "2.0", id, result });
}

export function rpcError(
    id: number | undefined,
    code: number,
    message: string,
    data?: unknown,
): string {
    return JSON.stringify({
        jsonrpc: "2.0",
        id: id ?? 0,
        error: { code, message, ...(data === undefined ? {} : { data }) },
    });
}

export function rpcNotification(method: string, params: unknown): string {
    return JSON.stringify({ jsonrpc: "2.0", method, params });
}

export function asRecord(value: unknown): Record<string, unknown> {
    return isRecord(value) ? (value as Record<string, unknown>) : {};
}

export function stringArray(value: unknown): string[] {
    return Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string")
        : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
