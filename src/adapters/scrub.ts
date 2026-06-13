import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";

/**
 * Deletes rows matching `column = value` from a sqlite table, then VACUUMs so
 * the data is purged from free pages too (no recoverable residue). Uses
 * whatever sqlite tooling is on the system — python3 (stdlib sqlite3) first,
 * then the sqlite3 CLI. `table`/`column` must be trusted identifiers (callers
 * pass hardcoded names); `value` is bound as a parameter / validated GUID.
 *
 * Returns true when a tool ran the scrub, false when none was available.
 */
export async function scrubSqliteRows(
    dbPath: string,
    table: string,
    column: string,
    value: string,
): Promise<boolean> {
    try {
        await fs.promises.access(dbPath);
    } catch {
        return true; // no db, nothing to scrub
    }
    if (await runPython(dbPath, table, column, value)) {
        return true;
    }
    return runSqliteCli(dbPath, table, column, value);
}

function spawnOk(cmd: string, args: string[]): Promise<boolean> {
    return new Promise((resolve) => {
        let child;
        try {
            child = spawn(cmd, args, { stdio: ["ignore", "ignore", "ignore"] });
        } catch {
            resolve(false);
            return;
        }
        child.on("error", () => resolve(false));
        child.on("exit", (code) => resolve(code === 0));
    });
}

function runPython(dbPath: string, table: string, column: string, value: string): Promise<boolean> {
    const script =
        "import sqlite3,sys\n" +
        "db=sqlite3.connect(sys.argv[1])\n" +
        `db.execute("DELETE FROM ${table} WHERE ${column}=?",(sys.argv[2],))\n` +
        "db.commit()\n" +
        "db.execute('VACUUM')\n" +
        "db.commit()\n" +
        "db.close()\n";
    return spawnOk("python3", ["-c", script, dbPath, value]);
}

function runSqliteCli(dbPath: string, table: string, column: string, value: string): Promise<boolean> {
    // Only GUID-shaped values reach here; reject anything else defensively.
    if (!/^[0-9a-fA-F-]{8,}$/.test(value)) {
        return Promise.resolve(false);
    }
    const sql = `DELETE FROM ${table} WHERE ${column}='${value}'; VACUUM;`;
    return spawnOk("sqlite3", [dbPath, sql]);
}

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
