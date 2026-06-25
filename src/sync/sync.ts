import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import {
    ensureScaffold, readState, ResourceKind, resourceContentPath,
    rootDir, sanitize, scanAll, writeState,
} from "../config/root";
import { HubClient, Observation } from "./hubClient";

/**
 * Bidirectional sync between the local ~/.symposium/repo (runtime source of
 * truth, offline-first) and the sufficit-ai memory hub (distribution between
 * machines). Idempotent and content-hash based. Push is health-gated: it only
 * writes to the hub when the hub is reachable.
 *
 * Mapping: one resource (file/bundle manifest) ↔ one memory observation.
 *   type    = agent-def | agent-skill | agent-tool | agent-instruction
 *   title   = name        summary = description
 *   payload = JSON { kind, name, content }
 */

const TYPE_OF: Record<ResourceKind, string> = {
    agent: "agent-def",
    skill: "agent-skill",
    tool: "agent-tool",
    instruction: "agent-instruction",
    bootstrap: "agent-bootstrap",
};
const KIND_OF: Record<string, ResourceKind> = {
    "agent-def": "agent",
    "agent-skill": "skill",
    "agent-tool": "tool",
    "agent-instruction": "instruction",
    "agent-bootstrap": "bootstrap",
};

interface MapEntry { id: string; hash: string; }
type SyncMap = Record<string, MapEntry>; // key = "<kind>/<name>"

export interface SyncResult { pushed: number; pulled: number; skipped: number; errors: string[]; }

function hashOf(content: string): string {
    return createHash("sha256").update(content, "utf8").digest("hex");
}

function mapPath(): string {
    return path.join(rootDir(), "cache", "sync-map.json");
}

function readMap(): SyncMap {
    try {
        return JSON.parse(fs.readFileSync(mapPath(), "utf8")) as SyncMap;
    } catch {
        return {};
    }
}

function writeMap(map: SyncMap): void {
    fs.mkdirSync(path.dirname(mapPath()), { recursive: true });
    fs.writeFileSync(mapPath(), JSON.stringify(map, null, 2), "utf8");
}

function readContent(kind: ResourceKind, name: string): string | null {
    try {
        return fs.readFileSync(resourceContentPath(kind, name), "utf8");
    } catch {
        return null;
    }
}

export class SyncEngine {
    constructor(private readonly hub: HubClient) { }

    /** Push local resources to the hub (health-gated). Returns a summary. */
    async push(): Promise<SyncResult> {
        ensureScaffold();
        const result: SyncResult = { pushed: 0, pulled: 0, skipped: 0, errors: [] };
        if (!this.hub.configured()) {
            result.errors.push("hub not configured (symposium.hub.url).");
            return result;
        }
        if (!(await this.hub.health())) {
            result.errors.push("hub unavailable — push blocked (health-gate).");
            return this.persist(result, false, "push");
        }

        const map = readMap();
        const all = scanAll();
        const pending: string[] = [];
        for (const kind of Object.keys(all) as ResourceKind[]) {
            for (const entry of all[kind]) {
                const key = `${kind}/${entry.name}`;
                const content = readContent(kind, entry.name);
                if (content == null) {
                    continue;
                }
                const hash = hashOf(content);
                const known = map[key];
                if (known && known.hash === hash) {
                    result.skipped++;
                    continue;
                }
                const obs: Observation = {
                    id: known?.id, // present → update, absent → create
                    type: TYPE_OF[kind],
                    title: entry.name,
                    summary: entry.description || entry.name,
                    payload: JSON.stringify({ kind, name: entry.name, content }),
                    tags: `scope:symposium,kind:${kind}`,
                };
                try {
                    const id = await this.hub.save(obs);
                    map[key] = { id, hash };
                    result.pushed++;
                } catch (err) {
                    result.errors.push(`push ${key}: ${err}`);
                    pending.push(key);
                }
            }
        }
        writeMap(map);
        return this.persist(result, true, "push", pending);
    }

    /** Pull hub resources into local files. Writes only on content change. */
    async pull(): Promise<SyncResult> {
        ensureScaffold();
        const result: SyncResult = { pushed: 0, pulled: 0, skipped: 0, errors: [] };
        if (!this.hub.configured()) {
            result.errors.push("hub not configured (symposium.hub.url).");
            return result;
        }
        if (!(await this.hub.health())) {
            result.errors.push("hub unavailable — using local cache.");
            return this.persist(result, false, "pull");
        }

        const map = readMap();
        for (const type of Object.keys(KIND_OF)) {
            let records;
            try {
                records = await this.hub.searchByType(type);
            } catch (err) {
                result.errors.push(`pull ${type}: ${err}`);
                continue;
            }
            const ids = records.map((r) => r.id);
            let full;
            try {
                full = await this.hub.getByIds(ids);
            } catch (err) {
                result.errors.push(`pull payload ${type}: ${err}`);
                continue;
            }
            for (const obs of full) {
                const parsed = this.parsePayload(obs.payload);
                if (!parsed) {
                    continue;
                }
                const { kind, name, content } = parsed;
                const hash = hashOf(content);
                const file = resourceContentPath(kind, sanitize(name));
                const local = readContent(kind, sanitize(name));
                if (local != null && hashOf(local) === hash) {
                    map[`${kind}/${name}`] = { id: obs.id ?? "", hash };
                    result.skipped++;
                    continue;
                }
                try {
                    fs.mkdirSync(path.dirname(file), { recursive: true });
                    fs.writeFileSync(file, content, "utf8");
                    map[`${kind}/${name}`] = { id: obs.id ?? "", hash };
                    result.pulled++;
                } catch (err) {
                    result.errors.push(`write ${kind}/${name}: ${err}`);
                }
            }
        }
        writeMap(map);
        return this.persist(result, true, "pull");
    }

    private parsePayload(payload?: string): { kind: ResourceKind; name: string; content: string } | null {
        if (!payload) {
            return null;
        }
        try {
            const p = JSON.parse(payload) as { kind?: string; name?: string; content?: string };
            if (!p.kind || !p.name || typeof p.content !== "string") {
                return null;
            }
            const kind = p.kind as ResourceKind;
            if (!(kind in TYPE_OF)) {
                return null;
            }
            return { kind, name: p.name, content: p.content };
        } catch {
            return null;
        }
    }

    /** Records health + last-sync + last result into state.json so the UI reflects it. */
    private persist(result: SyncResult, healthy: boolean, label: string, pending: string[] = []): SyncResult {
        const state = readState();
        // Reachable (health passed) but the hub rejected the credentials.
        const unauthorized = healthy && result.errors.some((e) => /\b40[13]\b/.test(e));
        state.health = !healthy ? "down" : unauthorized ? "unauthorized" : "ok";
        if (healthy && !unauthorized) {
            state.lastSyncUtc = new Date().toISOString();
        }
        state.pendingPush = pending;
        state.lastResult = {
            label,
            pushed: result.pushed,
            pulled: result.pulled,
            skipped: result.skipped,
            errors: result.errors,
            at: new Date().toISOString(),
        };
        writeState(state);
        return result;
    }
}
