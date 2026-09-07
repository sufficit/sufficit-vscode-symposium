/** Value coercion and diagnostic helpers for the AHP projection runtime. */
import type { AgentEvent } from "../adapters/types";

export function isAgentEvent(value: unknown): value is AgentEvent {
    return (
        !!value &&
        typeof value === "object" &&
        typeof (value as { kind?: unknown }).kind === "string"
    );
}

export function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export function optionalString(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
}

export function optionalTimestamp(value: unknown): number | undefined {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
    return value;
}

export function stringArray(value: unknown): string[] {
    return Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string")
        : [];
}

export function sessionKey(provider: string, sessionId: string): string {
    return `${provider}:${sessionId}`;
}

export function positive(value: number | undefined, fallback: number): number {
    return Number.isSafeInteger(value) && (value ?? 0) > 0 ? (value as number) : fallback;
}

export function redact(value: string): string {
    return value
        .replace(
            /(authorization|cookie|secret|token|credential)\s*[:=]\s*[^;,}\s]+/gi,
            "$1=[redacted]",
        )
        .slice(0, 8_000);
}
