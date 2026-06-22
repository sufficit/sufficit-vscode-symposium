import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { symposiumLog } from "../extension";

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

/** Directory to run git in for a file — git discovers the enclosing repo upward. */
export function repoCwd(file: string): string {
    return path.dirname(file);
}

/** True when a VS Code Simple Browser tab is open in any tab group. */
export function isSimpleBrowserOpen(): boolean {
    for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
            const input = tab.input as { viewType?: string } | undefined;
            if (input && typeof input.viewType === "string" && /simplebrowser/i.test(input.viewType)) {
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
    if (!filePath || !ed) { return { path: filePath }; }
    // VS Code "preview" tab (italic title): a peeked file, not really opened.
    // We surface it only as a context suggestion, not an auto-attachment.
    let preview = false;
    const tab = vscode.window.tabGroups.activeTabGroup?.activeTab;
    const input = tab?.input as { uri?: vscode.Uri } | undefined;
    if (tab?.isPreview && input?.uri?.fsPath === filePath) { preview = true; }
    const sel = ed.selection;
    if (sel.isEmpty) { return { path: filePath, preview }; }
    const start = sel.start.line + 1;
    const end = sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line : sel.end.line + 1;
    const startColumn = sel.start.character + 1;
    const endColumn = sel.end.character + 1;
    return { path: filePath, start, end, startColumn, endColumn, preview };
}

const IMAGE_EXT: Record<string, string> = {
    "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif",
    "image/webp": "webp", "image/bmp": "bmp", "image/svg+xml": "svg",
};

/** Writes a pasted image (base64) to a temp file and returns its attachment descriptor. */
export async function writePastedImage(mime: string, base64: string): Promise<AttachmentFile | undefined> {
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

export async function writeDroppedFile(name: string | undefined, mime: string | undefined, base64: string): Promise<AttachmentFile | undefined> {
    if (!base64) {
        return undefined;
    }
    const safeName = path.basename(String(name || `drop-${Date.now()}`)).replace(/[\\/]/g, "_");
    const inferred = mime && IMAGE_EXT[mime] ? `drop-${Date.now()}.${IMAGE_EXT[mime]}` : `drop-${Date.now()}-${safeName}`;
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
