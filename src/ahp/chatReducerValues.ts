/** Value coercion helpers for the AHP chat reducer. */

export function optionalString(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
}

export function stringArray(value: unknown): string[] {
    return Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string")
        : [];
}

export function asArray<T>(value: unknown): T[] {
    return Array.isArray(value) ? (value as T[]) : [];
}

export function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export function nonNegative(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}
