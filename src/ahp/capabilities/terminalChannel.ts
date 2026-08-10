import type { Snapshot, URI } from "@microsoft/agent-host-protocol";
import type { AhpHostRuntime, AhpSessionHandle } from "../hostRuntime";
import { stableAhpUuid, terminalUri } from "../channelUris";
import { AHP_CAPABILITIES, AhpCapabilityRegistry } from "./registry";

interface TerminalRecord {
    resource: URI;
    ownerSession: URI;
    claimedBy?: string;
    output: string;
    offset: number;
}

export interface AhpTerminalOptions {
    enabled: boolean;
    maxOutputChars?: number;
    maxInputBytes?: number;
    maxActionsPerSecond?: number;
    input(text: string): void;
    resize(columns: number, rows: number): void;
    allowed(permission: string | undefined): boolean;
}

/** Bounded terminal tail with exclusive input ownership. */
export class AhpTerminalChannel {
    private readonly records = new Map<URI, TerminalRecord>();
    private readonly rates = new Map<string, number[]>();
    private readonly maxOutput: number;
    private readonly maxInput: number;
    private readonly maxRate: number;

    constructor(
        private readonly runtime: AhpHostRuntime,
        private readonly capabilities: AhpCapabilityRegistry,
        private readonly options: AhpTerminalOptions,
    ) {
        this.maxOutput = positive(options.maxOutputChars, 128_000);
        this.maxInput = positive(options.maxInputBytes, 8_192);
        this.maxRate = positive(options.maxActionsPerSecond, 30);
        capabilities.set(AHP_CAPABILITIES.terminal, options.enabled);
    }

    create(handle: AhpSessionHandle, terminalId: string): URI {
        this.requireEnabled();
        const resource = terminalUri(stableAhpUuid(`terminal:${handle.sessionId}:${terminalId}`));
        const record: TerminalRecord = {
            resource,
            ownerSession: handle.sessionResource,
            output: "",
            offset: 0,
        };
        this.records.set(resource, record);
        this.runtime.registerChannel(resource, publicState(record) as unknown as Snapshot["state"]);
        this.capabilities.advertiseForSession(handle.sessionResource, [AHP_CAPABILITIES.terminal]);
        return resource;
    }

    append(resource: URI, chunk: string): void {
        const record = this.requireRecord(resource);
        const redacted = redact(chunk);
        record.output += redacted;
        if (record.output.length > this.maxOutput) {
            const removed = record.output.length - this.maxOutput;
            record.output = record.output.slice(removed);
            record.offset += removed;
        }
        this.publish(record);
    }

    claim(resource: URI, clientId: string, permission?: string): boolean {
        const record = this.requireRecord(resource);
        if (!this.options.allowed(permission)) return false;
        if (record.claimedBy && record.claimedBy !== clientId) return false;
        record.claimedBy = clientId;
        this.publish(record);
        return true;
    }

    release(resource: URI, clientId: string): boolean {
        const record = this.requireRecord(resource);
        if (record.claimedBy !== clientId) return false;
        record.claimedBy = undefined;
        this.publish(record);
        return true;
    }

    input(resource: URI, clientId: string, text: string): void {
        const record = this.requireOwner(resource, clientId);
        if (Buffer.byteLength(text) > this.maxInput)
            throw new Error("Terminal input exceeds limit");
        this.acceptRate(clientId);
        this.options.input(text);
        this.publish(record);
    }

    resize(resource: URI, clientId: string, columns: number, rows: number): void {
        this.requireOwner(resource, clientId);
        this.acceptRate(clientId);
        if (!Number.isInteger(columns) || !Number.isInteger(rows) || columns < 10 || rows < 2) {
            throw new Error("Invalid terminal dimensions");
        }
        this.options.resize(Math.min(columns, 500), Math.min(rows, 300));
    }

    disconnect(clientId: string): void {
        this.rates.delete(clientId);
        for (const record of this.records.values()) {
            if (record.claimedBy !== clientId) continue;
            record.claimedBy = undefined;
            this.publish(record);
        }
    }

    private requireOwner(resource: URI, clientId: string): TerminalRecord {
        const record = this.requireRecord(resource);
        if (record.claimedBy !== clientId)
            throw new Error("Terminal input is not owned by this client");
        return record;
    }

    private requireRecord(resource: URI): TerminalRecord {
        this.requireEnabled();
        const record = this.records.get(resource);
        if (!record) throw new Error("Terminal channel not found");
        return record;
    }

    private acceptRate(clientId: string): void {
        const now = Date.now();
        const current = (this.rates.get(clientId) ?? []).filter((time) => now - time < 1_000);
        current.push(now);
        this.rates.set(clientId, current);
        if (current.length > this.maxRate) throw new Error("Terminal action rate exceeded");
    }

    private publish(record: TerminalRecord): void {
        this.runtime.dispatch(record.resource, {
            type: "symposium/channelStateChanged",
            replace: true,
            state: publicState(record),
        });
    }

    private requireEnabled(): void {
        if (!this.options.enabled) throw new Error("Terminal capability is disabled");
    }
}

function publicState(record: TerminalRecord): Record<string, unknown> {
    return {
        ownerSession: record.ownerSession,
        output: record.output,
        offset: record.offset,
        claimedBy: record.claimedBy,
    };
}

function redact(value: string): string {
    return value
        .replace(/((?:token|secret|password|authorization)\s*[=:]\s*)\S+/gi, "$1[redacted]")
        .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, "Bearer [redacted]");
}

function positive(value: number | undefined, fallback: number): number {
    return Number.isSafeInteger(value) && (value ?? 0) > 0 ? (value as number) : fallback;
}
