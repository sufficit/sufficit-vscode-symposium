import type { ResponsePart } from "@microsoft/agent-host-protocol";

export function isEmptyStreamAnchor(part: ResponsePart): boolean {
    return (part.kind === "markdown" || part.kind === "reasoning") && part.content === "";
}

export function coalesceReasoningParts(parts: readonly ResponsePart[]): ResponsePart[] {
    const grouped: ResponsePart[] = [];
    for (const part of parts) {
        if (isEmptyStreamAnchor(part)) continue;
        const previous = grouped.at(-1);
        if (part.kind === "reasoning" && previous?.kind === "reasoning") {
            grouped[grouped.length - 1] = { ...previous, content: previous.content + part.content };
        } else {
            grouped.push(part);
        }
    }
    return grouped;
}

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

export function severity(value: unknown): "info" | "warning" | "error" {
    return value === "warning" || value === "error" ? value : "info";
}

export function approvalTier(value: Record<string, unknown>): "write" | "destructive" {
    return asRecord(asRecord(value._meta).symposium).tier === "destructive"
        ? "destructive"
        : "write";
}
