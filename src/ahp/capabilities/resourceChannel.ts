import * as fs from "node:fs";
import * as path from "node:path";
import type { Snapshot, URI } from "@microsoft/agent-host-protocol";
import type { AhpHostRuntime, AhpSessionHandle } from "../hostRuntime";
import { resourceUri, stableAhpUuid } from "../channelUris";
import { AHP_CAPABILITIES, AhpCapabilityRegistry } from "./registry";
import { isSecretBearingPath, resolveAllowedPath } from "./pathPolicy";

interface ResourceRecord {
    resource: URI;
    path: string;
    ownerSession: URI;
    ownerChat: URI;
    protected: boolean;
}

export interface AhpResourceOptions {
    enabled: boolean;
    allowedRoots: readonly string[];
    maxReadBytes?: number;
    maxWriteBytes?: number;
    maxWatches?: number;
    allowWrite?: boolean;
}

/** Opaque, session-scoped references for attachments and workspace files. */
export class AhpResourceChannel {
    private readonly records = new Map<URI, ResourceRecord>();
    private readonly watches = new Map<string, fs.FSWatcher>();
    private readonly maxRead: number;
    private readonly maxWrite: number;
    private readonly maxWatches: number;

    constructor(
        private readonly runtime: AhpHostRuntime,
        private readonly capabilities: AhpCapabilityRegistry,
        private readonly options: AhpResourceOptions,
    ) {
        this.maxRead = positive(options.maxReadBytes, 256 * 1024);
        this.maxWrite = positive(options.maxWriteBytes, 256 * 1024);
        this.maxWatches = positive(options.maxWatches, 16);
        capabilities.set(AHP_CAPABILITIES.resources, options.enabled);
    }

    register(handle: AhpSessionHandle, candidate: string): URI {
        this.requireEnabled();
        const safe = resolveAllowedPath(candidate, this.options.allowedRoots);
        const resource = resourceUri(stableAhpUuid(`resource:${handle.chatId}:${safe.absolute}`));
        const stat = fs.statSync(safe.absolute);
        const protectedResource = isSecretBearingPath(safe.relative);
        const record = {
            resource,
            path: safe.absolute,
            ownerSession: handle.sessionResource,
            ownerChat: handle.chatResource,
            protected: protectedResource,
        };
        this.records.set(resource, record);
        const state = {
            ownerSession: record.ownerSession,
            ownerChat: record.ownerChat,
            name: protectedResource ? "[protected]" : path.basename(safe.absolute),
            size: stat.size,
            protected: protectedResource,
            operations: this.options.allowWrite ? ["read", "write", "watch"] : ["read", "watch"],
        };
        if (this.runtime.store.has(resource)) {
            this.runtime.dispatch(resource, {
                type: "symposium/channelStateChanged",
                replace: true,
                state,
            });
        } else {
            this.runtime.registerChannel(resource, state as unknown as Snapshot["state"]);
        }
        this.capabilities.advertiseForSession(handle.sessionResource, [AHP_CAPABILITIES.resources]);
        return resource;
    }

    read(
        resource: URI,
        ownerChat: URI,
        offset = 0,
        length = this.maxRead,
        authenticated = false,
    ): Buffer {
        const record = this.authorize(resource, ownerChat, authenticated);
        const size = Math.min(this.maxRead, positive(length, this.maxRead));
        const file = fs.openSync(record.path, "r");
        try {
            const output = Buffer.alloc(size);
            const read = fs.readSync(file, output, 0, size, Math.max(0, offset));
            return output.subarray(0, read);
        } finally {
            fs.closeSync(file);
        }
    }

    write(resource: URI, ownerChat: URI, content: Buffer, authenticated = false): void {
        if (!this.options.allowWrite) throw new Error("Resource writes are disabled");
        if (content.byteLength > this.maxWrite)
            throw new Error("Resource write exceeds the size limit");
        const record = this.authorize(resource, ownerChat, authenticated);
        fs.writeFileSync(record.path, content);
    }

    watch(
        clientId: string,
        resource: URI,
        ownerChat: URI,
        changed: () => void,
        authenticated = false,
    ): () => void {
        const key = `${clientId}:${resource}`;
        if (this.watches.has(key)) return () => this.closeWatch(key);
        if (this.watches.size >= this.maxWatches) throw new Error("Resource watch limit reached");
        const record = this.authorize(resource, ownerChat, authenticated);
        const watcher = fs.watch(record.path, { persistent: false }, changed);
        this.watches.set(key, watcher);
        return () => this.closeWatch(key);
    }

    disconnect(clientId: string): void {
        for (const key of this.watches.keys()) {
            if (key.startsWith(`${clientId}:`)) this.closeWatch(key);
        }
    }

    disposeSession(session: URI): void {
        for (const [resource, record] of this.records) {
            if (record.ownerSession !== session) continue;
            this.records.delete(resource);
            this.runtime.store.remove(resource);
        }
    }

    private authorize(resource: URI, ownerChat: URI, authenticated: boolean): ResourceRecord {
        this.requireEnabled();
        const record = this.records.get(resource);
        if (!record || record.ownerChat !== ownerChat)
            throw new Error("Resource ownership mismatch");
        if (record.protected && !authenticated)
            throw new Error("Protected resource authentication required");
        resolveAllowedPath(record.path, this.options.allowedRoots);
        return record;
    }

    private closeWatch(key: string): void {
        this.watches.get(key)?.close();
        this.watches.delete(key);
    }

    private requireEnabled(): void {
        if (!this.options.enabled) throw new Error("Resource capability is disabled");
    }
}

function positive(value: number | undefined, fallback: number): number {
    return Number.isSafeInteger(value) && (value ?? 0) > 0 ? (value as number) : fallback;
}
