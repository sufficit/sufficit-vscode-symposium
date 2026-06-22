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
    updatedAt: string;
    messages: ChatMsg[];
}

/** Per-backend store dir for API-adapter transcripts (no CLI to persist them). */
export function storeDir(backend: string): string {
    return path.join(os.homedir(), ".symposium", "sessions", backend);
}
export function storePath(backend: string, id: string): string {
    return path.join(storeDir(backend), id + ".json");
}
export function readStored(backend: string, id: string): StoredSession | undefined {
    try { return JSON.parse(fs.readFileSync(storePath(backend, id), "utf8")); } catch { return undefined; }
}
export function writeStored(s: StoredSession): void {
    try {
        fs.mkdirSync(storeDir(s.backend), { recursive: true });
        fs.writeFileSync(storePath(s.backend, s.id), JSON.stringify(s));
    } catch { /* best-effort persistence */ }
}
