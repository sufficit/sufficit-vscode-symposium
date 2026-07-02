import * as fs from "fs";
import { resourcePath } from "./root";

/** Parses all simple `key: value` pairs from a leading frontmatter block. */
function parseFrontmatterRaw(text: string): Record<string, string> {
    const out: Record<string, string> = {};
    if (!text.startsWith("---")) {
        return out;
    }
    const end = text.indexOf("\n---", 3);
    if (end === -1) {
        return out;
    }
    for (const line of text.slice(3, end).split("\n")) {
        const m = /^([a-zA-Z0-9_]+)\s*:\s*(.*)$/.exec(line);
        if (m) {
            out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
        }
    }
    return out;
}

/**
 * Reads a tool's vault binding from its frontmatter: `credentialRef` (the vault
 * reference) and optional `credentialEnv` (the env var the secret is injected
 * into). Returns nulls when the tool or fields are absent.
 */
export function readToolCredential(name: string): { ref: string | null; env: string | null } {
    try {
        const text = fs.readFileSync(resourcePath("tool", name), "utf8");
        const fm = parseFrontmatterRaw(text);
        return { ref: fm["credentialRef"] || null, env: fm["credentialEnv"] || null };
    } catch {
        return { ref: null, env: null };
    }
}

/**
 * Reads an agent-def's declared capability tokens from its `tools:` frontmatter
 * (e.g. `tools: [read, edit, 'sufficit-ai/*', web]`). Returns [] when absent.
 */
export function readAgentTools(name: string): string[] {
    try {
        const fm = parseFrontmatterRaw(fs.readFileSync(resourcePath("agent", name), "utf8"));
        const raw = fm["tools"];
        if (!raw) {
            return [];
        }
        return raw.replace(/^\[|\]$/g, "")
            .split(",")
            .map((t) => t.trim().replace(/^["']|["']$/g, ""))
            .filter(Boolean);
    } catch {
        return [];
    }
}

/** Reads an agent-def's `bootstrap:` field. Defaults to true for compatible agents
 * created before this field existed. */
export function readAgentBootstrap(name: string): boolean {
    try {
        const v = parseFrontmatterRaw(fs.readFileSync(resourcePath("agent", name), "utf8"))["bootstrap"];
        if (v === undefined || v === "") { return true; }
        return v.toLowerCase() !== "false";
    } catch {
        return true;
    }
}
/** Reads an agent-def's `model:` pin (a label or id). Empty when absent. */
export function readAgentModel(name: string): string {
    try {
        return parseFrontmatterRaw(fs.readFileSync(resourcePath("agent", name), "utf8"))["model"] ?? "";
    } catch {
        return "";
    }
}

/**
 * Reads an agent-def's `backend:` preference/constraint (e.g. `openai`, `claude`,
 * a comma-list, or a wildcard like `gpt-*`). Empty when absent — meaning the
 * subagent inherits the spawning conversation's backend. Used by the subagent
 * spawner to pick and validate the backend a subagent runs on.
 */
export function readAgentBackend(name: string): string {
    try {
        return parseFrontmatterRaw(fs.readFileSync(resourcePath("agent", name), "utf8"))["backend"] ?? "";
    } catch {
        return "";
    }
}

/** Returns an agent-def's body (the markdown after frontmatter) = its instructions. */
export function readAgentBody(name: string): string {
    try {
        const text = fs.readFileSync(resourcePath("agent", name), "utf8");
        if (!text.startsWith("---")) {
            return text.trim();
        }
        const end = text.indexOf("\n---", 3);
        return end === -1 ? text.trim() : text.slice(end + 4).replace(/^\s+/, "");
    } catch {
        return "";
    }
}
