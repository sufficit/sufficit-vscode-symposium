import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * Resolves a CLI name to an absolute path. GUI-launched VS Code can carry a
 * PATH without the user's shell additions, so after PATH we probe the usual
 * install locations. Names containing a separator are taken as-is.
 */
export function resolveExecutable(name: string): string {
    if (name.includes(path.sep)) {
        return name;
    }
    const candidates = [
        ...(process.env.PATH ?? "").split(path.delimiter),
        path.join(os.homedir(), ".local", "bin"),
        "/usr/local/bin",
        "/usr/bin",
        "/opt/homebrew/bin",
    ];
    for (const dir of candidates) {
        if (!dir) {
            continue;
        }
        const full = path.join(dir, name);
        try {
            fs.accessSync(full, fs.constants.X_OK);
            return full;
        } catch {
            // keep probing
        }
    }
    return name;
}
