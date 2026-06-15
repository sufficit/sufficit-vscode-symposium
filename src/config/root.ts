import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

/**
 * Local storage root for Symposium's vendor-neutral agent knowledge.
 *
 * Layout (see sufficit-ai/docs/TODO-agent-knowledge-sync.md):
 *   ~/.symposium/
 *     repo/{agents,skills,tools,instructions}/   git-versioned canonical source
 *     index/                                     light index for offline search
 *     projections/<backend>/                     adapter output (ephemeral)
 *     cache/                                     sync state (etags/hashes)
 *     state.json                                 health, last sync, pending pushes
 *
 * The root is the runtime source: Symposium reads agents from these files and
 * works offline. The memory REST API only distributes them between machines.
 */

export type ResourceKind = "agent" | "skill" | "tool" | "instruction";

export interface ResourceEntry {
    kind: ResourceKind;
    name: string;
    description: string;
    /** Absolute path to the resource file (or the SKILL.md for a skill bundle). */
    path: string;
    /** True for multi-file skill bundles. */
    bundle: boolean;
}

export interface SyncState {
    /** Last known health of the sufficit-ai memory hub. */
    health: "ok" | "down" | "unknown";
    /** ISO timestamp of the last successful sync, if any. */
    lastSyncUtc?: string;
    /** Resource names with local edits not yet pushed to the hub. */
    pendingPush: string[];
}

const DEFAULT_STATE: SyncState = { health: "unknown", pendingPush: [] };

/** Maps each resource kind to its subdirectory under repo/. */
const KIND_DIR: Record<ResourceKind, string> = {
    agent: "agents",
    skill: "skills",
    tool: "tools",
    instruction: "instructions",
};

/** Resolves the configured root, defaulting to ~/.symposium. */
export function rootDir(): string {
    const configured = vscode.workspace.getConfiguration("symposium").get<string>("root", "");
    if (configured && configured.trim()) {
        return configured.replace(/^~(?=$|\/)/, os.homedir());
    }
    return path.join(os.homedir(), ".symposium");
}

export function repoDir(): string {
    return path.join(rootDir(), "repo");
}

export function projectionsDir(backend: string): string {
    return path.join(rootDir(), "projections", backend);
}

/** Creates the directory scaffold if missing. Idempotent. */
export function ensureScaffold(): void {
    const root = rootDir();
    const dirs = [
        repoDir(),
        ...Object.values(KIND_DIR).map((d) => path.join(repoDir(), d)),
        path.join(root, "index"),
        path.join(root, "projections"),
        path.join(root, "cache"),
    ];
    for (const dir of dirs) {
        fs.mkdirSync(dir, { recursive: true });
    }
    const gitignore = path.join(root, ".gitignore");
    if (!fs.existsSync(gitignore)) {
        fs.writeFileSync(gitignore, "projections/\ncache/\n", "utf8");
    }
    const stateFile = path.join(root, "state.json");
    if (!fs.existsSync(stateFile)) {
        writeState(DEFAULT_STATE);
    }
}

/** Reads `name`/`description` from a leading YAML-ish frontmatter block. */
function parseFrontmatter(text: string): { name?: string; description?: string } {
    if (!text.startsWith("---")) {
        return {};
    }
    const end = text.indexOf("\n---", 3);
    if (end === -1) {
        return {};
    }
    const out: { name?: string; description?: string } = {};
    for (const line of text.slice(3, end).split("\n")) {
        const m = /^(name|description)\s*:\s*(.*)$/.exec(line);
        if (m) {
            (out as Record<string, string>)[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
        }
    }
    return out;
}

/** Reads name/description for a single-file resource, falling back to the filename. */
function readFileResource(kind: ResourceKind, file: string): ResourceEntry {
    const fallback = path.basename(file).replace(/\.(md|json)$/i, "");
    let meta: { name?: string; description?: string } = {};
    try {
        meta = parseFrontmatter(fs.readFileSync(file, "utf8"));
    } catch {
        // unreadable file: keep filename-only entry
    }
    return {
        kind,
        name: meta.name ?? fallback,
        description: meta.description ?? "",
        path: file,
        bundle: false,
    };
}

/** Reads a skill bundle from its directory (manifest = SKILL.md). */
function readSkillBundle(dir: string): ResourceEntry {
    const manifest = path.join(dir, "SKILL.md");
    const fallback = path.basename(dir);
    let meta: { name?: string; description?: string } = {};
    try {
        meta = parseFrontmatter(fs.readFileSync(manifest, "utf8"));
    } catch {
        // missing/unreadable manifest: keep directory-name entry
    }
    return {
        kind: "skill",
        name: meta.name ?? fallback,
        description: meta.description ?? "",
        path: manifest,
        bundle: true,
    };
}

/** Scans the repo for resources of one kind. Returns [] if the dir is absent. */
export function scanKind(kind: ResourceKind): ResourceEntry[] {
    const dir = path.join(repoDir(), KIND_DIR[kind]);
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return [];
    }
    const out: ResourceEntry[] = [];
    for (const entry of entries) {
        if (kind === "skill") {
            if (entry.isDirectory()) {
                out.push(readSkillBundle(path.join(dir, entry.name)));
            }
        } else if (entry.isFile() && /\.(md|json)$/i.test(entry.name)) {
            out.push(readFileResource(kind, path.join(dir, entry.name)));
        }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Scans all resource kinds. */
export function scanAll(): Record<ResourceKind, ResourceEntry[]> {
    return {
        agent: scanKind("agent"),
        skill: scanKind("skill"),
        tool: scanKind("tool"),
        instruction: scanKind("instruction"),
    };
}

/** Absolute path where a single-file resource of `kind`/`name` lives. */
export function resourcePath(kind: Exclude<ResourceKind, "skill">, name: string): string {
    return path.join(repoDir(), KIND_DIR[kind], `${sanitize(name)}.md`);
}

/**
 * Absolute path to the content file for any resource: the single `.md` for
 * agent/tool/instruction, or the `SKILL.md` manifest for a skill bundle. This is
 * the file the sync engine reads/writes as the resource's canonical content.
 */
export function resourceContentPath(kind: ResourceKind, name: string): string {
    if (kind === "skill") {
        return path.join(repoDir(), KIND_DIR.skill, sanitize(name), "SKILL.md");
    }
    return resourcePath(kind, name);
}

/** Strips path separators and unsafe chars from a resource name. */
export function sanitize(name: string): string {
    return name.replace(/[^a-zA-Z0-9._-]/g, "-");
}

/** Builds a minimal canonical frontmatter body for a new single-file resource. */
function template(kind: ResourceKind, name: string, description: string): string {
    const fm = [`name: ${name}`, `description: ${description}`, "version: 1"];
    if (kind === "agent") {
        fm.push("model: default", "tools: []", "skills: []", "instructions: []");
        return `---\n${fm.join("\n")}\n---\n\n# ${name}\n\nInstruções do agente aqui.\n`;
    }
    if (kind === "tool") {
        fm.push("transport: stdio", "command: ''", "capabilities: []", "credentialRef: ''");
        return `---\n${fm.join("\n")}\n---\n\n# ${name}\n\nDescrição da tool.\n`;
    }
    return `---\n${fm.join("\n")}\n---\n\n# ${name}\n\nConteúdo aqui.\n`;
}

/**
 * Creates a resource if absent and returns the path to open. Skills become a
 * bundle directory with a SKILL.md manifest; others are a single file.
 */
export function createResource(kind: ResourceKind, name: string, description = ""): string {
    ensureScaffold();
    if (kind === "skill") {
        const dir = path.join(repoDir(), KIND_DIR.skill, sanitize(name));
        fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
        fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
        const manifest = path.join(dir, "SKILL.md");
        if (!fs.existsSync(manifest)) {
            fs.writeFileSync(manifest, template("skill", name, description), "utf8");
        }
        return manifest;
    }
    const file = resourcePath(kind, name);
    if (!fs.existsSync(file)) {
        fs.writeFileSync(file, template(kind, name, description), "utf8");
    }
    return file;
}

/** Deletes a resource (single file, or the whole skill bundle directory). */
export function deleteResource(kind: ResourceKind, name: string): void {
    if (kind === "skill") {
        const dir = path.join(repoDir(), KIND_DIR.skill, sanitize(name));
        fs.rmSync(dir, { recursive: true, force: true });
        return;
    }
    fs.rmSync(resourcePath(kind, name), { force: true });
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

export function readState(): SyncState {
    try {
        const raw = fs.readFileSync(path.join(rootDir(), "state.json"), "utf8");
        return { ...DEFAULT_STATE, ...JSON.parse(raw) };
    } catch {
        return { ...DEFAULT_STATE };
    }
}

export function writeState(state: SyncState): void {
    fs.writeFileSync(path.join(rootDir(), "state.json"), JSON.stringify(state, null, 2), "utf8");
}
