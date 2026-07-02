/**
 * Host-side (native) microphone capture via ffmpeg.
 *
 * VS Code webviews lose getUserMedia permission between reloads/hides, so the
 * chat mic records HERE, in the extension host process, with the platform's
 * native audio input (dshow / avfoundation / pulse). The webview only sends
 * start/stop — no browser permission involved. Output is 16 kHz mono WAV,
 * ready for the local STT engines without a second ffmpeg pass.
 */
import { spawn, ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

let proc: ChildProcess | null = null;
let outPath = "";

function ff(ffmpegPath: string): string {
    return ffmpegPath && ffmpegPath.trim() ? ffmpegPath.trim() : "ffmpeg";
}

/** First DirectShow audio capture device name (Windows). */
function firstDshowAudioDevice(bin: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const p = spawn(bin, ["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"]);
        let err = "";
        p.stderr.on("data", (d) => { err += d.toString(); });
        p.on("error", (e) => reject(e));
        p.on("close", () => {
            // [dshow @ ...] "Microphone (Realtek ...)" (audio)
            const m = err.match(/"([^"]+)"\s*\(audio\)/);
            if (m) { resolve(m[1]); } else { reject(new Error("no audio input device found (dshow)")); }
        });
    });
}

async function inputArgs(bin: string): Promise<string[]> {
    if (process.platform === "win32") {
        const dev = await firstDshowAudioDevice(bin);
        return ["-f", "dshow", "-i", `audio=${dev}`];
    }
    if (process.platform === "darwin") { return ["-f", "avfoundation", "-i", ":0"]; }
    // Linux and WSLg (PulseAudio socket is exported by WSLg).
    return ["-f", "pulse", "-i", "default"];
}

export function isCapturing(): boolean { return !!proc; }

/** Starts recording. Rejects fast when ffmpeg dies immediately (no device/permission). */
export async function startCapture(ffmpegPath: string): Promise<void> {
    if (proc) { throw new Error("already recording"); }
    const bin = ff(ffmpegPath);
    const args = await inputArgs(bin);
    outPath = path.join(os.tmpdir(), `symposium-rec-${Date.now()}.wav`);
    const p = spawn(bin, ["-hide_banner", "-y", ...args, "-ac", "1", "-ar", "16000", outPath], { stdio: ["pipe", "ignore", "pipe"] });
    proc = p;
    let err = "";
    p.stderr.on("data", (d) => { err += d.toString(); });
    await new Promise<void>((resolve, reject) => {
        const ok = setTimeout(resolve, 700);   // still alive after 700ms → capturing
        p.on("error", (e) => { clearTimeout(ok); if (proc === p) { proc = null; } reject(e); });
        p.on("close", (code) => {
            clearTimeout(ok);
            if (proc === p) {
                proc = null;
                reject(new Error(`audio capture failed (ffmpeg code ${code}). ${err.split("\n").filter(Boolean).slice(-2).join(" ").trim()}`));
            }
        });
    });
}

/** Stops recording and returns the captured WAV path. */
export async function stopCapture(): Promise<string> {
    const p = proc;
    if (!p) { throw new Error("not recording"); }
    proc = null;
    await new Promise<void>((resolve) => {
        const done = setTimeout(resolve, 3000);          // hard cap
        p.on("close", () => { clearTimeout(done); resolve(); });
        try { p.stdin?.write("q"); } catch { /* fall through to kill */ }
        setTimeout(() => { try { p.kill(); } catch { /* gone */ } }, 1500);
    });
    if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 128) {
        throw new Error("no audio captured");
    }
    return outPath;
}

/** Aborts recording and discards the file. */
export function cancelCapture(): void {
    const p = proc;
    proc = null;
    if (p) {
        try { p.stdin?.write("q"); } catch { try { p.kill(); } catch { /* gone */ } }
    }
    setTimeout(() => { try { fs.unlinkSync(outPath); } catch { /* ignore */ } }, 500);
}
