import { JsonlMetadataCache, readJsonlPrefix } from "../jsonlPrefix";

/**
 * Codex sessions begin with injected scaffolding (AGENTS.md, IDE context,
 * environment tags) before the real prompt. These are wrapped in tags or
 * markdown headers, so skip `<...>` blocks and `# `-headed context for
 * titles and history.
 */
export function looksInjected(text: string): boolean {
    const value = text.trimStart();
    // The host forwards operational directives as separate user messages in a
    // Codex rollout. They are not a conversation task. Treating the first one
    // as a title made unrelated parent/subagent sessions all look like
    // "[Terminal execution] …", which in turn looked like duplicated work.
    return value.startsWith("<")
        || value.startsWith("# ")
        || /^\[(?:terminal execution|role|operational rule|plan|session|rtk command policy)\b/i.test(value);
}

/** Reads the session_meta line (id, cwd) and first real user prompt (title). */
export interface CodexMeta {
    id?: string;
    cwd?: string;
    title?: string;
    model?: string;
    lineageId?: string;
    parentId?: string;
    continuationBlockedReason?: "codex-subagent";
    /** Legacy Symposium branch seed, used only to recover a missing relation. */
    seedHistory?: string;
}

export interface CodexLineageCandidate {
    sessionId: string;
    lineageId?: string;
    historyText: string;
}

function assistantContent(historyText: string): string {
    return historyText
        .split(/\n\n(?=(?:user|assistant): )/)
        .filter((entry) => entry.startsWith("assistant: "))
        .map((entry) => entry.slice("assistant: ".length).trim())
        .join("");
}

/** Finds the first candidate whose visible history starts with the carried branch seed. */
export function inferCodexLineage(seedHistory: string, candidates: CodexLineageCandidate[]): string | undefined {
    const seed = seedHistory.trim();
    let match = candidates.find((candidate) => candidate.historyText.trim().startsWith(seed));
    if (!match) {
        // Legacy branches did not carry an explicit lineage marker. Their UI
        // seed can merge consecutive assistant events while the Codex JSONL
        // keeps each event separate; injected host instructions may also hide
        // the corresponding user row from history(). Compare the ordered
        // assistant content as a conservative fallback. Short generic replies
        // are deliberately ignored to avoid linking unrelated conversations.
        const assistantSeed = assistantContent(seed);
        if (assistantSeed.length >= 160) {
            match = candidates.find((candidate) => assistantContent(candidate.historyText).startsWith(assistantSeed));
        }
    }
    return match ? match.lineageId || match.sessionId : undefined;
}

const codexMetaCache = new JsonlMetadataCache<CodexMeta>();
const CODEX_META_PREFIX_BYTES = 2 * 1024 * 1024;

export async function readCodexMeta(file: string): Promise<CodexMeta> {
    return codexMetaCache.get(file, async () => parseCodexMeta(
        await readJsonlPrefix(file, CODEX_META_PREFIX_BYTES),
    ));
}

function parseCodexMeta(content: string): CodexMeta {
    let id: string | undefined;
    let cwd: string | undefined;
    let title: string | undefined;
    let model: string | undefined;
    let lineageId: string | undefined;
    let parentId: string | undefined;
    let continuationBlockedReason: "codex-subagent" | undefined;
    let seedHistory: string | undefined;
    for (const [index, line] of content.split("\n").entries()) {
        if (!line.trim()) {
            continue;
        }
        interface CodexEntry {
            type: string;
            payload?: {
                type?: string;
                id?: string;
                cwd?: string;
                role?: string;
                content?: Array<{ type: string; text?: string }>;
                model?: string;
                parent_thread_id?: string | null;
                source?: {
                    subagent?: {
                        thread_spawn?: { parent_thread_id?: string };
                    };
                };
            };
        }
        let entry: CodexEntry;
        try {
            entry = JSON.parse(line);
        } catch {
            continue;
        }
        if (entry.type === "session_meta" && !id) {
            id = entry.payload?.id;
            cwd = entry.payload?.cwd;
            const subagent = entry.payload?.source?.subagent;
            const nativeParentId = entry.payload?.parent_thread_id
                ?? subagent?.thread_spawn?.parent_thread_id;
            if (subagent && typeof nativeParentId === "string") {
                // Codex multi-agent v2 rollouts cannot accept direct app-server
                // input. This is a spawned-agent tree relationship, not an
                // edit/resend lineage; classifying it as lineage made the UI
                // offer Resume and fail only after the user submitted text.
                parentId = nativeParentId;
                continuationBlockedReason = "codex-subagent";
            } else if (typeof nativeParentId === "string") {
                lineageId = nativeParentId;
            }
        } else if (entry.type === "turn_context" && typeof entry.payload?.model === "string") {
            model = entry.payload.model;
        } else if (!title && index < 60 && entry.type === "response_item" && entry.payload?.type === "message" && entry.payload.role === "user") {
            const text = (entry.payload.content ?? [])
                .filter((c: { type: string }) => c.type === "input_text" || c.type === "text")
                .map((c: { text?: string }) => c.text)
                .join("")
                .trim();
            const branchMarker = text.match(/lineage:\s*([0-9a-f-]{36})/i);
            if (branchMarker) { lineageId = branchMarker[1]; }
            const seedStartMarker = "=== Conversation so far ===\n";
            const seedEndMarker = "\n=== End of conversation so far ===";
            const seedStart = text.indexOf(seedStartMarker);
            const seedEnd = seedStart >= 0 ? text.indexOf(seedEndMarker, seedStart + seedStartMarker.length) : -1;
            if (!seedHistory && seedStart >= 0 && seedEnd > seedStart) {
                seedHistory = text.slice(seedStart + seedStartMarker.length, seedEnd).trim();
            }
            if (text && !looksInjected(text)) {
                title = text.slice(0, 80);
            }
        }
    }
    return {
        id, cwd, title, model,
        ...(lineageId ? { lineageId } : {}),
        ...(parentId ? { parentId } : {}),
        ...(continuationBlockedReason ? { continuationBlockedReason } : {}),
        ...(seedHistory ? { seedHistory } : {}),
    };
}
