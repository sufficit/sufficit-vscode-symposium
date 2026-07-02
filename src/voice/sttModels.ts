/**
 * On-demand model storage for the local STT engines.
 *
 * Downloads are plain HTTPS streams (no extra dependencies); Vosk archives are
 * expanded with the system `unzip`. Everything lives under the extension's
 * global storage so models survive reloads and are shared across workspaces.
 */
import * as fs from "fs";
import * as path from "path";
import * as https from "https";
import { spawn } from "child_process";
import { SttModelSpec, findModel } from "./sttCatalog";

let storageRoot = "";

/** Called once at activation with context.globalStorageUri.fsPath. */
export function initModelStorage(globalStoragePath: string): void {
    storageRoot = path.join(globalStoragePath, "voice-models");
}

/** Root folder for downloaded models (override comes from settings, resolved by the caller). */
export function modelsDir(override?: string): string {
    const root = override && override.trim() ? override.trim() : storageRoot;
    return root;
}

function engineDir(root: string, engine: string): string {
    return path.join(root, engine);
}

/** Absolute on-disk path a model resolves to once installed (file or directory). */
export function modelPath(spec: SttModelSpec, root: string): string {
    const dir = engineDir(root, spec.engine);
    if (spec.kind === "file") {
        // whisper.cpp expects the canonical ggml-<id>.bin name.
        return path.join(dir, `ggml-${spec.id}.bin`);
    }
    return path.join(dir, spec.id);
}

export function isInstalled(spec: SttModelSpec, root: string): boolean {
    const p = modelPath(spec, root);
    return fs.existsSync(p);
}

export interface DownloadProgress {
    received: number;
    total: number;
    /** 0..1, or -1 when the server sends no content-length. */
    ratio: number;
}

/** Milliseconds of socket inactivity before a download is aborted. */
const DOWNLOAD_IDLE_TIMEOUT_MS = 30_000;

/** Streams a URL to a file, following redirects, reporting progress. */
function httpDownload(url: string, dest: string, onProgress: (p: DownloadProgress) => void): Promise<void> {
    return new Promise((resolve, reject) => {
        let out: fs.WriteStream | undefined;
        /** Rejects, closing the write stream and removing the partial file. */
        const fail = (e: Error) => {
            if (out) {
                out.destroy();
                out = undefined;
                try { fs.unlinkSync(dest); } catch { /* ignore */ }
            }
            reject(e);
        };
        const get = (target: string, redirectsLeft: number) => {
            const req = https.get(target, { headers: { "User-Agent": "symposium-vscode" } }, (res) => {
                const status = res.statusCode ?? 0;
                if (status >= 300 && status < 400 && res.headers.location) {
                    res.resume();
                    if (redirectsLeft <= 0) { fail(new Error("Too many redirects")); return; }
                    const next = new URL(res.headers.location, target).toString();
                    get(next, redirectsLeft - 1);
                    return;
                }
                if (status !== 200) {
                    res.resume();
                    fail(new Error(`HTTP ${status} for ${target}`));
                    return;
                }
                const total = Number(res.headers["content-length"] || 0);
                let received = 0;
                const file = fs.createWriteStream(dest);
                out = file;
                res.on("data", (chunk: Buffer) => {
                    received += chunk.length;
                    onProgress({ received, total, ratio: total > 0 ? received / total : -1 });
                });
                res.pipe(file);
                file.on("finish", () => file.close(() => resolve()));
                file.on("error", (e) => fail(e));
                res.on("error", (e) => fail(e));
            });
            req.setTimeout(DOWNLOAD_IDLE_TIMEOUT_MS, () => {
                req.destroy(new Error(`Download stalled (no data for ${DOWNLOAD_IDLE_TIMEOUT_MS / 1000}s): ${target}`));
            });
            req.on("error", (e) => fail(e));
        };
        get(url, 5);
    });
}

/** Extracts a zip into `targetDir` using the system unzip, flattening a single top folder. */
function unzip(zipPath: string, targetDir: string): Promise<void> {
    return new Promise((resolve, reject) => {
        fs.mkdirSync(targetDir, { recursive: true });
        const child = spawn("unzip", ["-o", zipPath, "-d", targetDir], { stdio: "ignore" });
        child.on("error", (e) => reject(new Error(`unzip failed (${e.message}). Install 'unzip' or extract manually.`)));
        child.on("close", (code) => {
            if (code !== 0) { reject(new Error(`unzip exited with code ${code}`)); return; }
            // Vosk archives contain a single top-level folder; lift its contents up.
            try {
                const entries = fs.readdirSync(targetDir);
                if (entries.length === 1) {
                    const inner = path.join(targetDir, entries[0]);
                    if (fs.statSync(inner).isDirectory()) {
                        for (const f of fs.readdirSync(inner)) {
                            fs.renameSync(path.join(inner, f), path.join(targetDir, f));
                        }
                        fs.rmdirSync(inner);
                    }
                }
            } catch { /* leave structure as extracted */ }
            resolve();
        });
    });
}

/**
 * Downloads (and for zips, extracts) a model by id. Reports progress; resolves
 * to the installed on-disk path. No-op-safe: re-downloads overwrite cleanly.
 */
export async function downloadModel(
    modelId: string,
    root: string,
    onProgress: (p: DownloadProgress) => void,
): Promise<string> {
    const spec = findModel(modelId);
    if (!spec) { throw new Error(`Unknown model: ${modelId}`); }
    const dir = engineDir(root, spec.engine);
    fs.mkdirSync(dir, { recursive: true });
    const finalPath = modelPath(spec, root);

    if (spec.kind === "file") {
        const tmp = finalPath + ".part";
        await httpDownload(spec.url, tmp, onProgress);
        fs.renameSync(tmp, finalPath);
        return finalPath;
    }

    // zip: download to temp, extract into the model directory, drop the archive.
    const tmpZip = path.join(dir, spec.id + ".zip");
    await httpDownload(spec.url, tmpZip, onProgress);
    await unzip(tmpZip, finalPath);
    try { fs.unlinkSync(tmpZip); } catch { /* ignore */ }
    return finalPath;
}

/** Removes an installed model (file or directory). Returns true if anything was removed. */
export function deleteModel(modelId: string, root: string): boolean {
    const spec = findModel(modelId);
    if (!spec) { return false; }
    const p = modelPath(spec, root);
    if (!fs.existsSync(p)) { return false; }
    fs.rmSync(p, { recursive: true, force: true });
    return true;
}
