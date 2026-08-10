import { createHash } from "crypto";
import type { URI } from "@microsoft/agent-host-protocol";

export const AHP_ROOT_URI = "ahp-root://" as URI;

export type AhpChannelKind =
    | "session"
    | "chat"
    | "terminal"
    | "changeset"
    | "resource"
    | "customization";

export interface ParsedAhpUri {
    kind: AhpChannelKind | "annotations" | "otlp";
    id?: string;
    signal?: "logs" | "metrics" | "traces";
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isStableUuid(value: string): boolean {
    return UUID_PATTERN.test(value);
}

/** Produces a deterministic RFC-4122-shaped UUID for a stable native key. */
export function stableAhpUuid(value: string): string {
    if (isStableUuid(value)) {
        return value.toLowerCase();
    }
    const bytes = Buffer.from(createHash("sha256").update(value).digest().subarray(0, 16));
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function channelUri(kind: AhpChannelKind, id: string): URI {
    if (!isStableUuid(id)) {
        throw new Error(`AHP ${kind} identity must be a stable UUID`);
    }
    return `ahp-${kind}:/${id.toLowerCase()}` as URI;
}

export const sessionUri = (id: string): URI => channelUri("session", id);
export const chatUri = (id: string): URI => channelUri("chat", id);
export const terminalUri = (id: string): URI => channelUri("terminal", id);
export const changesetUri = (id: string): URI => channelUri("changeset", id);
export const resourceUri = (id: string): URI => channelUri("resource", id);
export const customizationUri = (id: string): URI => channelUri("customization", id);

export function annotationsUri(sessionId: string): URI {
    if (!isStableUuid(sessionId)) {
        throw new Error("AHP annotations identity must be a stable session UUID");
    }
    return `ahp-session:/${sessionId.toLowerCase()}/annotations` as URI;
}

export function otlpUri(signal: "logs" | "metrics" | "traces"): URI {
    return `ahp-otlp://${signal}` as URI;
}

export function parseAhpUri(resource: string): ParsedAhpUri {
    if (resource === AHP_ROOT_URI) {
        throw new Error("The root URI has no resource identity");
    }
    const otlp = /^ahp-otlp:\/\/(logs|metrics|traces)$/.exec(resource);
    if (otlp) {
        return { kind: "otlp", signal: otlp[1] as ParsedAhpUri["signal"] };
    }
    const annotation = /^ahp-session:\/([^/]+)\/annotations$/.exec(resource);
    if (annotation) {
        assertUuid(annotation[1], "annotations");
        return { kind: "annotations", id: annotation[1].toLowerCase() };
    }
    const match = /^ahp-(session|chat|terminal|changeset|resource|customization):\/([^/]+)$/.exec(
        resource,
    );
    if (!match) {
        throw new Error(`Malformed or unsupported AHP URI: ${resource}`);
    }
    assertUuid(match[2], match[1]);
    return { kind: match[1] as AhpChannelKind, id: match[2].toLowerCase() };
}

function assertUuid(value: string, kind: string): void {
    if (!isStableUuid(value)) {
        throw new Error(`AHP ${kind} URI must contain a stable UUID`);
    }
}
