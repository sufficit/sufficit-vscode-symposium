import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ChatMsg } from "./types";

export interface StoredSession {
    id: string;
    backend: string;
    title: string;
    cwd: string;
    model: string;
    reasoning?: string;
    updatedAt: string;
    messages: ChatMsg[];
    /** Conversation lineage inherited at branch time (see SessionStartOptions.lineageId). */
    lineageId?: string;
}

/** Metadata-only view of a stored session — listing never needs `messages`. */
export type StoredSessionMeta = Omit<StoredSession, "messages">;

/** Per-backend store dir for API-adapter transcripts (no CLI to persist them). */
export function storeDir(backend: string, homeDir: string = os.homedir()): string {
    return path.join(homeDir, ".symposium", "sessions", backend);
}
export function storePath(backend: string, id: string, homeDir?: string): string {
    return path.join(storeDir(backend, homeDir), id + ".json");
}
/** Small metadata sidecar written next to the transcript (issue #40 phase 6). */
export function metaPath(backend: string, id: string, homeDir?: string): string {
    return path.join(storeDir(backend, homeDir), id + ".meta.json");
}
export function readStored(
    backend: string,
    id: string,
    homeDir?: string,
): StoredSession | undefined {
    try {
        return JSON.parse(fs.readFileSync(storePath(backend, id, homeDir), "utf8"));
    } catch {
        return undefined;
    }
}
/** Strips `messages`, keeping exactly the fields listing needs. */
export function metaOf(s: StoredSession): StoredSessionMeta {
    const { messages: _messages, ...meta } = s;
    return meta;
}
/**
 * Reads only session metadata, asynchronously. Prefers the `<id>.meta.json`
 * sidecar written by writeStored(); falls back to parsing the legacy
 * `<id>.json` transcript when the sidecar does not exist yet, so files
 * written by older versions remain listable.
 */
export async function readStoredMeta(
    backend: string,
    id: string,
    homeDir?: string,
): Promise<StoredSessionMeta | undefined> {
    try {
        return JSON.parse(await fs.promises.readFile(metaPath(backend, id, homeDir), "utf8"));
    } catch {
        try {
            const stored: StoredSession = JSON.parse(
                await fs.promises.readFile(storePath(backend, id, homeDir), "utf8"),
            );
            return metaOf(stored);
        } catch {
            return undefined;
        }
    }
}
export function writeStored(s: StoredSession, homeDir?: string): void {
    try {
        fs.mkdirSync(storeDir(s.backend, homeDir), { recursive: true });
        fs.writeFileSync(storePath(s.backend, s.id, homeDir), JSON.stringify(s));
        // Listing reads this sidecar instead of the full transcript, so it never
        // parses `messages` (issue #40 phase 6).
        fs.writeFileSync(metaPath(s.backend, s.id, homeDir), JSON.stringify(metaOf(s)));
    } catch {
        /* best-effort persistence */
    }
}
/** Removes the transcript and its metadata sidecar. */
export function deleteStored(backend: string, id: string, homeDir?: string): void {
    for (const file of [storePath(backend, id, homeDir), metaPath(backend, id, homeDir)]) {
        try {
            fs.rmSync(file, { force: true });
        } catch {
            /* ignore */
        }
    }
}
