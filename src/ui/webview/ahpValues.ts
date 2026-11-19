export function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export function optionalString(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
}

export function numberValue(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function contentText(value: unknown): string {
    if (!Array.isArray(value)) return "";
    return value.map((item) => stringContent(asRecord(item).text)).join("");
}

export function stringContent(value: unknown): string {
    if (typeof value === "string") return value;
    const record = asRecord(value);
    return optionalString(record.value) ?? optionalString(record.text) ?? "";
}
