import * as fs from "fs";
import * as path from "path";
import { SlashCommand } from "./types";

/** Merges command lists, first-wins on name, keeping built-ins ahead of skills. */
export function mergeCommands(...lists: SlashCommand[][]): SlashCommand[] {
    const byName = new Map<string, SlashCommand>();
    for (const list of lists) {
        for (const cmd of list) {
            if (!byName.has(cmd.name)) {
                byName.set(cmd.name, cmd);
            }
        }
    }
    return [...byName.values()];
}

/** Finds directories named `name` nested under `root` up to `maxDepth`. */
export async function findNamedDirs(root: string, name: string, maxDepth = 5): Promise<string[]> {
    const found: string[] = [];
    const walk = async (dir: string, depth: number): Promise<void> => {
        let entries: fs.Dirent[];
        try {
            entries = await fs.promises.readdir(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (!entry.isDirectory()) {
                continue;
            }
            const full = path.join(dir, entry.name);
            if (entry.name === name) {
                found.push(full);
            }
            if (depth < maxDepth) {
                await walk(full, depth + 1);
            }
        }
    };
    await walk(root, 0);
    return found;
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
    const block = text.slice(3, end);
    const out: { name?: string; description?: string } = {};
    for (const line of block.split("\n")) {
        const m = /^(name|description)\s*:\s*(.*)$/.exec(line);
        if (m) {
            const value = m[2].trim().replace(/^["']|["']$/g, "");
            const key = m[1] as "name" | "description";
            out[key] = value;
        }
    }
    return out;
}

async function readMeta(file: string): Promise<{ name?: string; description?: string }> {
    try {
        const text = await fs.promises.readFile(file, "utf-8");
        return parseFrontmatter(text);
    } catch {
        return {};
    }
}

/** Loads all slash commands from *.md files under a directory. */
export async function loadSlashCommands(root: string): Promise<SlashCommand[]> {
    const dirs = await findNamedDirs(root, "skills", 4);
    const cmds: SlashCommand[] = [];
    for (const dir of dirs) {
        let entries: fs.Dirent[];
        try {
            entries = await fs.promises.readdir(dir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            if (!entry.isFile() || !entry.name.endsWith(".md")) {
                continue;
            }
            const file = path.join(dir, entry.name);
            const meta = await readMeta(file);
            if (meta.name) {
                cmds.push({
                    name: meta.name,
                    description: meta.description ?? `Skill from ${entry.name}`,
                    kind: "skill",
                });
            }
        }
    }
    return cmds;
}