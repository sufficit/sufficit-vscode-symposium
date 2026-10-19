import { isRecord } from "./persistenceValidation";

/**
 * Incremental serialization support for AHP persistence.
 *
 * Channel states are produced by immutable reducers, so a state object that is
 * still referenced by the next export is byte-for-byte what was serialized the
 * previous time. Caching the redacted JSON per object identity turns a save of
 * a 20 MB cache into "re-serialize only the chats that changed" instead of
 * redacting, measuring and stringifying every chat on every write.
 */
export interface CachedJson {
    json: string;
    bytes: number;
}

export class AhpSerializationCache {
    hits = 0;
    misses = 0;
    /** Last payload cap applied, so the diagnostic is only reported on change. */
    lastCap = 0;
    private readonly values = new WeakMap<object, CachedJson>();
    private readonly capped = new WeakMap<object, Map<number, object>>();

    /** Redacted JSON of `value`, computed once per object identity. */
    json(value: object): CachedJson {
        const cached = this.values.get(value);
        if (cached) {
            this.hits++;
            return cached;
        }
        this.misses++;
        const json = JSON.stringify(value, redactingReplacer);
        const entry = { json, bytes: Buffer.byteLength(json) };
        this.values.set(value, entry);
        return entry;
    }

    has(value: object): boolean {
        return this.values.has(value);
    }

    /** Returns a chat state with oversized tool/reasoning strings shortened (memoized). */
    cap<T extends object>(state: T, maxChars: number): T {
        let byLimit = this.capped.get(state);
        const hit = byLimit?.get(maxChars);
        if (hit) return hit as T;
        const result = capChatState(state as unknown as Record<string, unknown>, maxChars);
        if (!byLimit) {
            byLimit = new Map();
            this.capped.set(state, byLimit);
        }
        byLimit.set(maxChars, result);
        // A capped state is already capped: make re-capping it a lookup.
        if (result !== state) this.capped.set(result, new Map([[maxChars, result]]));
        return result as T;
    }
}

/** Drops secrets while stringifying; equivalent to the former recursive redact copy. */
export function redactingReplacer(key: string, value: unknown): unknown {
    if (isProtectedKey(key)) return undefined;
    if (key === "_meta" && isRecord(value)) {
        let filtered: Record<string, unknown> | undefined;
        for (const childKey of Object.keys(value)) {
            if (!childKey.startsWith("private")) continue;
            filtered ??= { ...value };
            delete filtered[childKey];
        }
        return filtered ?? value;
    }
    return value;
}

function isProtectedKey(key: string): boolean {
    return /^(authorization|cookie|credential|credentials|env|environment|secret|token)$/i.test(
        key,
    );
}

function capChatState(state: Record<string, unknown>, maxChars: number): Record<string, unknown> {
    const turns = state.turns;
    if (!Array.isArray(turns)) return state;
    let changed = false;
    const nextTurns = turns.map((turn) => {
        if (!isRecord(turn) || !Array.isArray(turn.responseParts)) return turn;
        let partsChanged = false;
        const parts = turn.responseParts.map((part) => {
            if (!isRecord(part)) return part;
            if (part.kind === "toolCall" && part.toolCall !== undefined) {
                const toolCall = capStrings(part.toolCall, maxChars);
                if (toolCall === part.toolCall) return part;
                partsChanged = true;
                return { ...part, toolCall };
            }
            if (part.kind === "reasoning" && typeof part.content === "string") {
                const content = capStrings(part.content, maxChars);
                if (content === part.content) return part;
                partsChanged = true;
                return { ...part, content };
            }
            return part;
        });
        if (!partsChanged) return turn;
        changed = true;
        return { ...turn, responseParts: parts };
    });
    return changed ? { ...state, turns: nextTurns } : state;
}

/** Shortens every string leaf above `max`, preserving identity when nothing changed. */
function capStrings(value: unknown, max: number): unknown {
    if (typeof value === "string") return value.length > max ? shorten(value, max) : value;
    if (Array.isArray(value)) {
        let output: unknown[] | undefined;
        for (let i = 0; i < value.length; i++) {
            const next = capStrings(value[i], max);
            if (next === value[i]) continue;
            output ??= value.slice();
            output[i] = next;
        }
        return output ?? value;
    }
    if (isRecord(value)) {
        let output: Record<string, unknown> | undefined;
        for (const key of Object.keys(value)) {
            const next = capStrings(value[key], max);
            if (next === value[key]) continue;
            output ??= { ...value };
            output[key] = next;
        }
        return output ?? value;
    }
    return value;
}

function shorten(value: string, max: number): string {
    // Keep head and tail (errors usually sit at the end of tool output).
    const reserve = 40;
    const kept = Math.max(2, max - reserve);
    let head = Math.ceil(kept / 2);
    let tail = Math.floor(kept / 2);
    const headLast = value.charCodeAt(head - 1);
    if (headLast >= 0xd800 && headLast <= 0xdbff) head--; // never split a surrogate pair
    const tailFirst = value.charCodeAt(value.length - tail);
    if (tailFirst >= 0xdc00 && tailFirst <= 0xdfff) tail--;
    const omitted = value.length - head - tail;
    return `${value.slice(0, head)}\n…[truncated ${omitted} chars]…\n${tail ? value.slice(value.length - tail) : ""}`;
}
