import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";

export const MAX_MARKDOWN_IMAGE_BYTES = 10 * 1024 * 1024;

const IMAGE_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".avif": "image/avif",
};

export interface MarkdownImageResult {
    dataUrl?: string;
    error?: string;
}

export interface LocalFileTarget {
    fsPath: string;
    /** One-based line and column, matching Markdown link conventions. */
    line?: number;
    column?: number;
}

/** Resolves a Markdown file target without treating `file:` as a relative path. */
export function resolveLocalResourcePath(raw: string, cwd?: string): string | undefined {
    let value = String(raw || "").trim();
    if (!value) {
        return undefined;
    }
    if (/^file:/i.test(value)) {
        try {
            return fileURLToPath(value);
        } catch {
            return undefined;
        }
    }
    // Reject URL-like schemes, while retaining Windows drive paths.
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value) && !/^[A-Za-z]:[\\/]/.test(value)) {
        return undefined;
    }
    value = value.replace(/^~(?=$|[/\\])/, os.homedir());
    if (path.isAbsolute(value)) {
        return path.normalize(value);
    }
    return cwd ? path.resolve(cwd, value) : undefined;
}

/**
 * Resolves a clickable file target and separates an optional source location.
 * Agents conventionally emit `/absolute/file.ts:12[:4]` or `file.ts#L12C4`;
 * those suffixes select an editor position and are not part of the filename.
 */
export function resolveLocalFileTarget(
    raw: string,
    cwd?: string,
    workspaceRoots: readonly string[] = [],
): LocalFileTarget | undefined {
    let value = String(raw || "").trim();
    if (!value) {
        return undefined;
    }

    let line: number | undefined;
    let column: number | undefined;
    const hashLocation = value.match(/^(.*)#L(\d+)(?:C(\d+))?$/i);
    const colonLocation = hashLocation
        ? undefined
        : (value.match(/^(.*):(\d+):(\d+)$/) ?? value.match(/^(.*):(\d+)$/));
    const location = hashLocation ?? colonLocation;
    if (location) {
        value = location[1];
        line = Number(location[2]);
        column = location[3] ? Number(location[3]) : undefined;
        if (
            !Number.isSafeInteger(line) ||
            line < 1 ||
            (column !== undefined && (!Number.isSafeInteger(column) || column < 1))
        ) {
            return undefined;
        }
    }

    const fsPath =
        resolveWorkspaceQualifiedPath(value, workspaceRoots) ??
        resolveLocalResourcePath(value, cwd);
    return fsPath ? { fsPath, line, column } : undefined;
}

/** Resolves `workspace-name/path` against the matching VS Code workspace root. */
function resolveWorkspaceQualifiedPath(
    value: string,
    roots: readonly string[],
): string | undefined {
    if (
        /^file:/i.test(value) ||
        /^~(?=$|[/\\])/.test(value) ||
        path.isAbsolute(value) ||
        /^[A-Za-z]:[\\/]/.test(value)
    ) {
        return undefined;
    }
    const [workspaceName, ...relativeParts] = value.split(/[\\/]/);
    const candidates = roots
        .filter((root) => path.basename(path.normalize(root)) === workspaceName)
        .map((root) => ({ root, target: path.resolve(root, ...relativeParts) }))
        .filter(({ root, target }) => isInside(root, target));
    return candidates.find(({ target }) => fs.existsSync(target))?.target ?? candidates[0]?.target;
}

/** Reads a bounded raster image only when it resolves inside an allowed root. */
export async function loadMarkdownImage(
    raw: string,
    cwd: string | undefined,
    allowedRoots: readonly string[],
): Promise<MarkdownImageResult> {
    const resolved = resolveLocalResourcePath(raw, cwd);
    if (!resolved) {
        return { error: "Invalid local image path." };
    }
    const mime = IMAGE_MIME_BY_EXTENSION[path.extname(resolved).toLowerCase()];
    if (!mime) {
        return { error: "Preview unavailable for this image type." };
    }
    try {
        const realFile = await fs.promises.realpath(resolved);
        const roots: string[] = [];
        for (const root of allowedRoots) {
            if (!root) {
                continue;
            }
            try {
                roots.push(await fs.promises.realpath(root));
            } catch {
                /* Ignore a stale workspace root. */
            }
        }
        if (!roots.some((root) => isInside(root, realFile))) {
            return { error: "Preview unavailable outside the active workspace." };
        }
        const stat = await fs.promises.stat(realFile);
        if (!stat.isFile()) {
            return { error: "The image target is not a file." };
        }
        if (stat.size > MAX_MARKDOWN_IMAGE_BYTES) {
            return { error: "Image is too large to preview." };
        }
        const bytes = await fs.promises.readFile(realFile);
        return { dataUrl: `data:${mime};base64,${bytes.toString("base64")}` };
    } catch {
        return { error: "Image file was not found." };
    }
}

function isInside(root: string, target: string): boolean {
    const relative = path.relative(root, target);
    return (
        relative === "" ||
        (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
    );
}
