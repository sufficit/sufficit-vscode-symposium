import { createHash } from "node:crypto";
import type { Snapshot, URI } from "@microsoft/agent-host-protocol";
import type { AhpSessionHandle, AhpHostRuntime } from "../hostRuntime";
import { changesetUri, stableAhpUuid } from "../channelUris";
import { AHP_CAPABILITIES, AhpCapabilityRegistry } from "./registry";
import { isSecretBearingPath, resolveAllowedPath } from "./pathPolicy";

export interface AhpChangedFile {
    path: string;
    added: number;
    removed: number;
}

export interface AhpChangesetDecision {
    clientId: string;
    resource: URI;
    fileId: string;
    decision: "apply" | "reject";
    expectedVersion: number;
}

interface ChangesetRecord {
    version: number;
    files: Map<string, { path: string; state: "pending" | "applied" | "rejected" }>;
}

export interface AhpChangesetOptions {
    enabled: boolean;
    allowedRoots: readonly string[];
    maxFiles?: number;
    decide(file: string, decision: "apply" | "reject"): Promise<void> | void;
}

/** Host-owned changed-file review channel with stale-decision protection. */
export class AhpChangesetChannel {
    private readonly records = new Map<URI, ChangesetRecord>();
    private readonly maximumFiles: number;

    constructor(
        private readonly runtime: AhpHostRuntime,
        private readonly capabilities: AhpCapabilityRegistry,
        private readonly options: AhpChangesetOptions,
    ) {
        this.maximumFiles = Math.max(1, options.maxFiles ?? 200);
        capabilities.set(AHP_CAPABILITIES.changesets, options.enabled);
    }

    publish(
        handle: AhpSessionHandle,
        turnId: string | undefined,
        changed: AhpChangedFile[],
    ): URI | undefined {
        if (!this.options.enabled) return undefined;
        const files = changed.slice(0, this.maximumFiles).map((item) => {
            const safe = resolveAllowedPath(item.path, this.options.allowedRoots);
            const id = createHash("sha256").update(safe.absolute).digest("hex").slice(0, 20);
            return {
                id,
                path: isSecretBearingPath(safe.relative) ? "[protected]" : safe.relative,
                added: boundedCount(item.added),
                removed: boundedCount(item.removed),
                state: "pending" as const,
                absolute: safe.absolute,
            };
        });
        const resource = changesetUri(
            stableAhpUuid(`changeset:${handle.sessionId}:${turnId ?? "working-tree"}`),
        );
        const record: ChangesetRecord = {
            version: (this.records.get(resource)?.version ?? 0) + 1,
            files: new Map(
                files.map((file) => [file.id, { path: file.absolute, state: file.state }]),
            ),
        };
        this.records.set(resource, record);
        const state = publicState(handle, turnId, record.version, files);
        if (this.runtime.store.has(resource)) {
            this.runtime.dispatch(resource, {
                type: "symposium/channelStateChanged",
                replace: true,
                state,
            });
        } else {
            this.runtime.registerChannel(resource, state as unknown as Snapshot["state"]);
        }
        this.runtime.dispatch(handle.sessionResource, {
            type: "session/changesetsChanged",
            changesets: [{ resource, status: "pending", files: files.length }],
        });
        this.capabilities.advertiseForSession(handle.sessionResource, [
            AHP_CAPABILITIES.changesets,
        ]);
        return resource;
    }

    async decide(input: AhpChangesetDecision): Promise<{ accepted: boolean; reason?: string }> {
        const record = this.records.get(input.resource);
        if (!record) return { accepted: false, reason: "changeset not found" };
        const file = record.files.get(input.fileId);
        if (!file) return { accepted: false, reason: "file not found" };
        const target = input.decision === "apply" ? "applied" : "rejected";
        if (file.state === target) return { accepted: true };
        if (record.version !== input.expectedVersion)
            return { accepted: false, reason: "stale version" };
        if (file.state !== "pending") return { accepted: false, reason: "decision conflict" };
        await this.options.decide(file.path, input.decision);
        file.state = target;
        record.version++;
        const snapshot = this.runtime.snapshot(input.resource).state as unknown as Record<
            string,
            unknown
        >;
        const files = Array.isArray(snapshot.files)
            ? snapshot.files.map((item) =>
                  (item as { id?: string }).id === input.fileId
                      ? { ...(item as object), state: target }
                      : item,
              )
            : [];
        this.runtime.dispatch(input.resource, {
            type: "symposium/channelStateChanged",
            state: { version: record.version, files, lastDecisionBy: input.clientId },
        });
        return { accepted: true };
    }
}

function publicState(
    handle: AhpSessionHandle,
    turnId: string | undefined,
    version: number,
    files: { id: string; path: string; added: number; removed: number; state: string }[],
): Record<string, unknown> {
    return {
        owner: "host",
        session: handle.sessionResource,
        chat: handle.chatResource,
        turnId,
        version,
        files: files.map(({ id, path, added, removed, state }) => ({
            id,
            path,
            added,
            removed,
            state,
        })),
    };
}

function boundedCount(value: number): number {
    return Number.isFinite(value) ? Math.max(0, Math.min(Math.trunc(value), 1_000_000)) : 0;
}
