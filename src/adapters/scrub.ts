import * as fs from "fs";
import * as path from "path";

/**
 * Rewrites a JSONL file dropping every line whose parsed object matches
 * `shouldDrop`. Written atomically (temp + rename). No-op if absent.
 * Used by secure delete to purge per-session entries from shared logs/indexes.
 */
export async function scrubJsonlLines(
    file: string,
    shouldDrop: (entry: any) => boolean,
): Promise<void> {
    let content: string;
    try {
        content = await fs.promises.readFile(file, "utf8");
    } catch {
        return; // file does not exist — nothing to scrub
    }
    const kept: string[] = [];
    let removed = false;
    for (const line of content.split("\n")) {
        if (!line.trim()) {
            continue;
        }
        let entry: any;
        try {
            entry = JSON.parse(line);
        } catch {
            kept.push(line); // preserve non-JSON lines untouched
            continue;
        }
        if (shouldDrop(entry)) {
            removed = true;
        } else {
            kept.push(line);
        }
    }
    if (!removed) {
        return;
    }
    const tmp = `${file}.symposium-tmp-${process.pid}`;
    await fs.promises.writeFile(tmp, kept.length ? kept.join("\n") + "\n" : "");
    await fs.promises.rename(tmp, file);
}

/**
 * Removes files in `dir` selected by a name predicate and/or an async
 * content predicate. Missing dir is a no-op.
 */
export async function removeMatchingFiles(
    dir: string,
    byName?: (name: string) => boolean,
    byContent?: (fullPath: string) => Promise<boolean>,
): Promise<void> {
    let entries: string[];
    try {
        entries = await fs.promises.readdir(dir);
    } catch {
        return;
    }
    for (const name of entries) {
        const full = path.join(dir, name);
        const nameMatch = byName ? byName(name) : false;
        const contentMatch = !nameMatch && byContent ? await byContent(full) : false;
        if (nameMatch || contentMatch) {
            await fs.promises.rm(full, { recursive: true, force: true });
        }
    }
}
