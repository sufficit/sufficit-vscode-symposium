import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

/**
 * Writes a single flat-dotted key into the user's settings.json directly.
 *
 * VS Code's Configuration API (`getConfiguration().update`) refuses to write a
 * setting no installed extension has registered — e.g. `gitlens.ai.ollama.url`
 * when GitLens isn't installed (or that key isn't in its schema), which throws
 * "not a registered configuration". Configuring third-party extensions requires
 * editing settings.json as a plain file.
 *
 * Pure JSON (no jsonc-parser dependency — it does not bundle cleanly under
 * esbuild, throwing "Cannot find module './impl/format'"). Comments/trailing
 * commas are tolerated on read; the file is rewritten as clean 2-space JSON.
 *
 * The path is derived from the extension's globalStorageUri
 * (`<...>/User/globalStorage/<ext>` → `<...>/User/settings.json`), correct on
 * desktop and code-server alike.
 */
/**
 * Reads a flat-dotted key straight from settings.json. Needed because
 * getConfiguration().get() returns "" for keys no installed extension
 * registered (gitlens.*, github.copilot.* when those aren't installed), which
 * would render the config fields empty and let a stray change clobber the file.
 */
export function readUserSetting(context: vscode.ExtensionContext, key: string): unknown {
    const userDir = path.resolve(context.globalStorageUri.fsPath, "..", "..");
    const file = path.join(userDir, "settings.json");
    try {
        const raw = fs.readFileSync(file, "utf8");
        const obj = tryParse(raw) ?? tryParse(stripJsonc(raw));
        return obj ? obj[key] : undefined;
    } catch {
        return undefined;
    }
}

export function writeUserSetting(
    context: vscode.ExtensionContext,
    key: string,
    value: unknown,
): void {
    const userDir = path.resolve(context.globalStorageUri.fsPath, "..", "..");
    const file = path.join(userDir, "settings.json");

    let raw = "";
    try {
        raw = fs.readFileSync(file, "utf8");
    } catch {
        /* first write */
    }

    let obj: Record<string, unknown> = {};
    if (raw.trim()) {
        obj = tryParse(raw) ?? tryParse(stripJsonc(raw)) ?? {};
    }

    obj[key] = value; // flat dotted key — settings.json stores keys unnested
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

/** Opens settings.json and reveals the line for `key` (creating it empty if
 *  absent), so raw values can be edited by hand. */
export async function openUserSettingAt(
    context: vscode.ExtensionContext,
    key: string,
): Promise<void> {
    const userDir = path.resolve(context.globalStorageUri.fsPath, "..", "..");
    const file = path.join(userDir, "settings.json");
    if (readUserSetting(context, key) === undefined) {
        writeUserSetting(context, key, "");
    }
    let line = 0;
    try {
        const lines = fs.readFileSync(file, "utf8").split("\n");
        const i = lines.findIndex((l) => l.includes(`"${key}"`));
        if (i >= 0) {
            line = i;
        }
    } catch {
        /* open at top if unreadable */
    }
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    const editor = await vscode.window.showTextDocument(doc);
    const pos = new vscode.Position(line, 0);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
}

function tryParse(text: string): Record<string, unknown> | undefined {
    try {
        const v = JSON.parse(text);
        return v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
    } catch {
        return undefined;
    }
}

/** Strips // and /* *\/ comments and trailing commas so JSONC parses as JSON. */
function stripJsonc(text: string): string {
    return text
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1")
        .replace(/,(\s*[}\]])/g, "$1");
}
