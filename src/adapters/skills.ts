import * as fs from "fs";
import * as path from "path";
import { SlashCommand } from "./types";

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
            let value = m[2].trim().replace(/^["']|["']$/g, "");
            (out as any)[m[1]] = value;
        }
    }
    return out;
}

async function readMeta(file: string): Promise<{ name?: string; description?: string }> {
    try {
        return parseFrontmatter(await fs.promises.readFile(file, "utf8"));
    } catch {
        return {};
    }
}

/**
 * Discovers slash commands for a CLI from its skill and command directories:
 *   - skillDirs/<name>/SKILL.md       → /<name>
 *   - commandDirs/<name>.md           → /<name>
 * Name comes from frontmatter when present, else the file/dir basename.
 * Deduplicated by name; hidden dot-entries skipped.
 */
export async function discoverSlashCommands(
    skillDirs: string[],
    commandDirs: string[],
): Promise<SlashCommand[]> {
    const byName = new Map<string, SlashCommand>();

    for (const dir of skillDirs) {
        let entries: fs.Dirent[];
        try {
            entries = await fs.promises.readdir(dir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            if (!entry.isDirectory() || entry.name.startsWith(".")) {
                continue;
            }
            const skillFile = path.join(dir, entry.name, "SKILL.md");
            try {
                await fs.promises.access(skillFile);
            } catch {
                continue; // empty placeholder dir without a SKILL.md
            }
            const meta = await readMeta(skillFile);
            const name = meta.name?.trim() || entry.name;
            if (!byName.has(name)) {
                byName.set(name, { name, description: meta.description, kind: "skill" });
            }
        }
    }

    for (const dir of commandDirs) {
        let entries: string[];
        try {
            entries = await fs.promises.readdir(dir);
        } catch {
            continue;
        }
        for (const file of entries) {
            if (!file.endsWith(".md") || file.startsWith(".") || file.toLowerCase() === "readme.md") {
                continue;
            }
            const meta = await readMeta(path.join(dir, file));
            const name = meta.name?.trim() || path.basename(file, ".md");
            if (!byName.has(name)) {
                byName.set(name, { name, description: meta.description, kind: "command" });
            }
        }
    }

    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
