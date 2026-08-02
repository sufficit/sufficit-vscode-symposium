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

/** Resolves a Markdown file target without treating `file:` as a relative path. */
export function resolveLocalResourcePath(raw: string, cwd?: string): string | undefined {
    let value = String(raw || "").trim();
    if (!value) { return undefined; }
    if (/^file:/i.test(value)) {
        try { return fileURLToPath(value); }
        catch { return undefined; }
    }
    // Reject URL-like schemes, while retaining Windows drive paths.
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value) && !/^[A-Za-z]:[\\/]/.test(value)) {
        return undefined;
    }
    value = value.replace(/^~(?=$|[/\\])/, os.homedir());
    if (path.isAbsolute(value)) { return path.normalize(value); }
    return cwd ? path.resolve(cwd, value) : undefined;
}

/** Reads a bounded raster image only when it resolves inside an allowed root. */
export async function loadMarkdownImage(
    raw: string,
    cwd: string | undefined,
    allowedRoots: readonly string[],
): Promise<MarkdownImageResult> {
    const resolved = resolveLocalResourcePath(raw, cwd);
    if (!resolved) { return { error: "Invalid local image path." }; }
    const mime = IMAGE_MIME_BY_EXTENSION[path.extname(resolved).toLowerCase()];
    if (!mime) { return { error: "Preview unavailable for this image type." }; }
    try {
        const realFile = await fs.promises.realpath(resolved);
        const roots: string[] = [];
        for (const root of allowedRoots) {
            if (!root) { continue; }
            try { roots.push(await fs.promises.realpath(root)); }
            catch { /* Ignore a stale workspace root. */ }
        }
        if (!roots.some((root) => isInside(root, realFile))) {
            return { error: "Preview unavailable outside the active workspace." };
        }
        const stat = await fs.promises.stat(realFile);
        if (!stat.isFile()) { return { error: "The image target is not a file." }; }
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
    return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
