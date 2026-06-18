import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as ledger from "./ledger";

/**
 * Cross-adapter session reading.
 *
 * Lets any backend re-read the full conversation of a Symposium chat session by
 * its GUID, regardless of which adapter owns it. Source priority:
 *   1. Ledger (~/.symposium/ledger/<id>/messages.jsonl) — lossless, never compacted.
 *   2. OpenAI/Sufficit-AI store (~/.symposium/sessions/<backend>/<id>.json).
 *   3. CLI transcripts (Claude ~/.claude/projects, Codex ~/.codex/sessions).
 *
 * The GUID is the canonical key everywhere (see store.ts), so a session opened in
 * one backend can still be located on disk by its id.
 */

export interface ReadMsg {
    role: string;
    text: string;
    at?: string;
}

export interface SessionDump {
    id: string;
    source: "ledger" | "store" | "cli" | "none";
    backend?: string;
    title?: string;
    count: number;
    messages: ReadMsg[];
}

/** Coerces an arbitrary content value (string or content-blocks) to plain text. */
function contentToText(content: unknown): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return content
            .map((b) => {
                if (typeof b === "string") return b;
                if (b && typeof b === "object") {
                    const o = b as Record<string, unknown>;
                    if (typeof o.text === "string") return o.text;
                    if (typeof o.content === "string") return o.content;
                }
                return "";
            })
            .filter(Boolean)
            .join("\n");
    }
    if (content && typeof content === "object") {
        const o = content as Record<string, unknown>;
        if (typeof o.text === "string") return o.text;
    }
    return "";
}

function fromLedger(id: string): SessionDump | undefined {
    if (!ledger.hasLedger(id)) return undefined;
    const raw = ledger.readMessages(id);
    if (!raw.length) return undefined;
    const messages: ReadMsg[] = raw.map((m) => ({
        role: String(m.role ?? "?"),
        text: contentToText(m.content),
        at: typeof m.at === "string" ? m.at : undefined,
    }));
    return { id, source: "ledger", count: messages.length, messages };
}

function storesRoot(): string {
    return path.join(os.homedir(), ".symposium", "sessions");
}

function fromStore(id: string): SessionDump | undefined {
    const root = storesRoot();
    let backends: string[] = [];
    try { backends = fs.readdirSync(root); } catch { return undefined; }
    for (const backend of backends) {
        const file = path.join(root, backend, id + ".json");
        if (!fs.existsSync(file)) continue;
        try {
            const s = JSON.parse(fs.readFileSync(file, "utf8")) as {
                title?: string; messages?: Array<{ role?: string; content?: unknown }>;
            };
            const messages: ReadMsg[] = (s.messages ?? []).map((m) => ({
                role: String(m.role ?? "?"),
                text: contentToText(m.content),
            })).filter((m) => m.text);
            return { id, source: "store", backend, title: s.title, count: messages.length, messages };
        } catch { /* try next */ }
    }
    return undefined;
}

/** Recursively finds the first file whose name contains the id under a root. */
function findFile(root: string, idFragment: string, depth = 4): string | undefined {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return undefined; }
    for (const e of entries) {
        const full = path.join(root, e.name);
        if (e.isFile() && e.name.includes(idFragment)) return full;
        if (e.isDirectory() && depth > 0) {
            const hit = findFile(full, idFragment, depth - 1);
            if (hit) return hit;
        }
    }
    return undefined;
}

function fromCliTranscript(id: string): SessionDump | undefined {
    const roots = [
        { backend: "claude", dir: path.join(os.homedir(), ".claude", "projects") },
        { backend: "codex", dir: path.join(os.homedir(), ".codex", "sessions") },
    ];
    for (const { backend, dir } of roots) {
        const file = findFile(dir, id);
        if (!file) continue;
        try {
            const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
            const messages: ReadMsg[] = [];
            for (const line of lines) {
                let row: Record<string, unknown>;
                try { row = JSON.parse(line); } catch { continue; }
                // Claude jsonl: { type:"user"|"assistant", message:{ role, content } }
                const msg = (row.message ?? row) as Record<string, unknown>;
                const role = String(msg.role ?? row.role ?? row.type ?? "");
                if (role !== "user" && role !== "assistant") continue;
                const text = contentToText(msg.content ?? row.content);
                if (text) messages.push({ role, text });
            }
            if (messages.length) return { id, source: "cli", backend, count: messages.length, messages };
        } catch { /* try next */ }
    }
    return undefined;
}

/** Reads a session's full conversation by GUID across all known sources. */
export function readSession(id: string): SessionDump {
    return (
        fromLedger(id) ??
        fromStore(id) ??
        fromCliTranscript(id) ??
        { id, source: "none", count: 0, messages: [] }
    );
}

/** Renders a session dump as compact text for a tool result. */
export function dumpToText(dump: SessionDump, opts?: { maxChars?: number; tail?: number }): string {
    const max = opts?.maxChars ?? 24000;
    let msgs = dump.messages;
    if (opts?.tail && opts.tail > 0 && msgs.length > opts.tail) {
        msgs = msgs.slice(-opts.tail);
    }
    const header = `session ${dump.id} · source=${dump.source}` +
        (dump.backend ? ` · backend=${dump.backend}` : "") +
        ` · ${dump.count} messages` +
        (msgs.length !== dump.count ? ` (showing last ${msgs.length})` : "");
    const body = msgs.map((m) => `[${m.role}]${m.at ? " " + m.at : ""}\n${m.text}`).join("\n\n");
    const out = header + "\n\n" + body;
    return out.length > max ? out.slice(out.length - max) : out;
}
