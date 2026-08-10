import * as fs from "node:fs";
import * as path from "node:path";

export interface AllowedPath {
    absolute: string;
    root: string;
    relative: string;
}

export function resolveAllowedPath(
    candidate: string,
    allowedRoots: readonly string[],
): AllowedPath {
    const absolute = fs.realpathSync(candidate);
    for (const configured of allowedRoots) {
        let root: string;
        try {
            root = fs.realpathSync(configured);
        } catch {
            continue;
        }
        const relative = path.relative(root, absolute);
        if (
            relative &&
            !relative.startsWith(`..${path.sep}`) &&
            relative !== ".." &&
            !path.isAbsolute(relative)
        ) {
            return { absolute, root, relative };
        }
        if (!relative) return { absolute, root, relative: path.basename(absolute) };
    }
    throw new Error("Path is outside the configured workspace roots");
}

export function isSecretBearingPath(value: string): boolean {
    const name = path.basename(value).toLowerCase();
    return (
        name === ".env" ||
        name.startsWith(".env.") ||
        /(^|[-_.])(secret|token|credential|private[-_.]?key)([-_.]|$)/i.test(name)
    );
}
