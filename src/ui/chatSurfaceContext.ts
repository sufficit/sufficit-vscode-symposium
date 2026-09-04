import * as crypto from "crypto";
import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import type { AdapterUsageProvider } from "../adapters/types";
import { symposiumLog } from "../extension/log";

export interface ActiveEditorContext {
    path?: string;
    start?: number;
    end?: number;
    startColumn?: number;
    endColumn?: number;
    preview?: boolean;
}

export interface AttachmentFile {
    path: string;
    name: string;
}

/** Empty snapshot used while a newly selected Sufficit preset is loading. */
export function presetQuotaLoadingEvent(usage: AdapterUsageProvider): unknown {
    return {
        type: "event",
        event: {
            kind: "quota",
            backend: usage.backend,
            displayName: usage.displayName,
            windows: [],
            updatedAt: Date.now(),
            state: "unavailable",
            message: "Reading usage for the selected preset…",
        },
    };
}

/** Directory to run git in for a file — git discovers the enclosing repo upward. */
export function repoCwd(file: string): string {
    return path.dirname(file);
}

/** True when a VS Code Simple Browser tab is open in any tab group. */
export function isSimpleBrowserOpen(): boolean {
    for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
            const input = tab.input as { viewType?: string } | undefined;
            if (
                input &&
                typeof input.viewType === "string" &&
                /simplebrowser/i.test(input.viewType)
            ) {
                return true;
            }
        }
    }
    return false;
}

/** Active-file context including a non-empty selection (1-based lines/columns). */
export function activeEditorContext(): ActiveEditorContext {
    const ed = vscode.window.activeTextEditor;
    const filePath = ed && ed.document.uri.scheme === "file" ? ed.document.uri.fsPath : undefined;
    if (!filePath || !ed) {
        return { path: filePath };
    }
    // Only a really-open file editor auto-attaches. Everything else — a preview
    // (italic) tab, or a DIFF view like git "Working Tree" (input has
    // original/modified URIs, not a plain uri) — is surfaced as a context
    // suggestion only, never auto-attached. Default to "preview" and clear it
    // solely for a plain, non-preview text editor whose tab matches the file.
    let preview = true;
    const tab = vscode.window.tabGroups.activeTabGroup?.activeTab;
    const input = tab?.input as
        | { uri?: vscode.Uri; original?: vscode.Uri; modified?: vscode.Uri }
        | undefined;
    const isPlainFileTab =
        !!input?.uri && !input.original && !input.modified && input.uri.fsPath === filePath;
    if (isPlainFileTab && !tab?.isPreview) {
        preview = false;
    }
    const sel = ed.selection;
    if (sel.isEmpty) {
        return { path: filePath, preview };
    }
    const start = sel.start.line + 1;
    const end =
        sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line : sel.end.line + 1;
    const startColumn = sel.start.character + 1;
    const endColumn = sel.end.character + 1;
    return { path: filePath, start, end, startColumn, endColumn, preview };
}

const IMAGE_EXT: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/bmp": "bmp",
    "image/svg+xml": "svg",
};

/** Writes a pasted image (base64) to a temp file and returns its attachment descriptor. */
export async function writePastedImage(
    mime: string,
    base64: string,
): Promise<AttachmentFile | undefined> {
    if (!base64) {
        return undefined;
    }
    const ext = IMAGE_EXT[mime] ?? "png";
    // Prefer workspace root so the agent can read the file without extra permission prompts.
    // Fall back to system tmpdir when no folder is open.
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const dir = wsRoot ? path.join(wsRoot, "tmp") : path.join(os.tmpdir(), "symposium-pastes");
    await fs.promises.mkdir(dir, { recursive: true });
    const buf = Buffer.from(base64, "base64");
    // Name by content hash so pasting the SAME image twice reuses one file
    // instead of piling up identical paste-<timestamp> copies.
    const hash = crypto.createHash("sha1").update(buf).digest("hex").slice(0, 16);
    const name = `paste-${hash}.${ext}`;
    const full = path.join(dir, name);
    try {
        await fs.promises.access(full);
        symposiumLog(`[surface] pasted image reused: ${full}`);
    } catch {
        await fs.promises.writeFile(full, buf);
        symposiumLog(`[surface] pasted image saved: ${full}`);
    }
    return { path: full, name };
}

export async function writeDroppedFile(
    name: string | undefined,
    mime: string | undefined,
    base64: string,
): Promise<AttachmentFile | undefined> {
    if (!base64) {
        return undefined;
    }
    const safeName = path.basename(String(name || `drop-${Date.now()}`)).replace(/[\\/]/g, "_");
    const inferred =
        mime && IMAGE_EXT[mime]
            ? `drop-${Date.now()}.${IMAGE_EXT[mime]}`
            : `drop-${Date.now()}-${safeName}`;
    const finalName = safeName && safeName !== "." ? safeName : inferred;
    const dir = path.join(os.tmpdir(), "symposium-drops");
    await fs.promises.mkdir(dir, { recursive: true });
    const full = path.join(dir, finalName);
    await fs.promises.writeFile(full, Buffer.from(base64, "base64"));
    symposiumLog(`[surface] dropped file saved: ${full}`);
    return { path: full, name: finalName };
}

export function attachmentFromUri(uri: string): AttachmentFile | undefined {
    try {
        const parsed = vscode.Uri.parse(uri.trim());
        if (parsed.scheme !== "file") {
            return undefined;
        }
        return { path: parsed.fsPath, name: path.basename(parsed.fsPath) };
    } catch {
        return undefined;
    }
}

/** Cap on clipboard image payloads read via external tools (25 MB). */
const CLIPBOARD_IMAGE_MAX_BYTES = 25 * 1024 * 1024;

/** Result of reading an image from the OS clipboard (Linux fallback path). */
export interface ClipboardImageRead {
    /** Attachment when an image was found and written to disk. */
    file?: AttachmentFile;
    /** Actionable hint when the clipboard may hold an image but no reader tool exists. */
    installHint?: string;
}

interface ClipboardReader {
    bin: string;
    listArgs: string[];
    readArgs: (mime: string) => string[];
}

/** Runs a clipboard tool; resolves with code+stdout (never rejects). */
function runCapture(
    bin: string,
    args: string[],
): Promise<{ code: number; stdout: Buffer; missing: boolean }> {
    return new Promise((resolve) => {
        execFile(
            bin,
            args,
            { encoding: "buffer", maxBuffer: CLIPBOARD_IMAGE_MAX_BYTES, timeout: 3000 },
            (err, stdout) => {
                const rawCode = (err as { code?: unknown } | null)?.code;
                resolve({
                    code: typeof rawCode === "number" ? rawCode : err ? 1 : 0,
                    stdout,
                    missing: (err as NodeJS.ErrnoException | null)?.code === "ENOENT",
                });
            },
        );
    });
}

/** First supported image MIME from a tool's offered target list (svg last resort). */
export function pickImageType(types: string[]): string | undefined {
    const offered = types.map((t) => t.trim()).filter(Boolean);
    const set = new Set(offered);
    const preferred = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp"];
    const explicit = preferred.find((mime) => set.has(mime));
    if (explicit) {
        return explicit;
    }
    const other = offered.find((t) => t.startsWith("image/") && t !== "image/svg+xml");
    return other || offered.find((t) => t === "image/svg+xml");
}

/** Ordered Linux clipboard readers: native Wayland first, then X11 (XWayland). */
function clipboardReaders(): ClipboardReader[] {
    const readers: ClipboardReader[] = [];
    if (process.platform === "linux" && process.env.WAYLAND_DISPLAY) {
        readers.push({
            bin: "wl-paste",
            listArgs: ["--list-types"],
            // -t/--type is a valued flag, NOT positional (wl-clipboard(1)).
            readArgs: (mime) => ["--no-newline", "--type", mime],
        });
    }
    if (process.platform === "linux" && (process.env.DISPLAY || readers.length === 0)) {
        readers.push({
            bin: "xclip",
            listArgs: ["-selection", "clipboard", "-t", "TARGETS", "-o"],
            readArgs: (mime) => ["-selection", "clipboard", "-t", mime, "-o"],
        });
    }
    return readers;
}

/**
 * Reads an image straight from the OS clipboard (Linux only).
 *
 * The webview's paste event often carries NO image item on Linux/Wayland
 * (Chromium exposes image-only clipboards with an empty item list), so the
 * extension host probes the clipboard itself: lists the offered MIME types
 * with wl-paste/xclip, picks the best image type, and reads its bytes.
 */
export async function readClipboardImage(): Promise<ClipboardImageRead> {
    const readers = clipboardReaders();
    const missing: string[] = [];
    for (const reader of readers) {
        const listed = await runCapture(reader.bin, reader.listArgs);
        if (listed.missing) {
            missing.push(reader.bin);
            continue;
        }
        if (listed.code !== 0) {
            continue;
        }
        const mime = pickImageType(listed.stdout.toString().split(/\r?\n/));
        if (!mime) {
            continue;
        }
        const read = await runCapture(reader.bin, reader.readArgs(mime));
        if (read.missing || read.code !== 0 || read.stdout.length === 0) {
            continue;
        }
        const file = await writePastedImage(mime, read.stdout.toString("base64"));
        if (file) {
            symposiumLog(`[surface] clipboard image read via ${reader.bin}: ${file.path}`);
            return { file };
        }
    }
    if (missing.length > 0 && missing.length === readers.length) {
        return {
            installHint:
                "No clipboard reader found — install 'wl-clipboard' (Wayland) and/or 'xclip' (X11) to paste images.",
        };
    }
    return {};
}
