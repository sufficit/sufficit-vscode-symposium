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
// ffmpeg takes a short moment to release the input device after `q`. Keeping
// this promise lets a new recording wait for that release instead of spawning
// a competing capture process (which commonly surfaces as a permission error
// on the second use of the microphone).
let stopping: Promise<void> | null = null;
// ffmpeg's own process exit does NOT mean PulseAudio has finished tearing down
// that client's connection to the "default" source server-side — there's a
// real gap between "our child process is gone" and "the audio server actually
// freed the device". Without this buffer, a start immediately following a
// stop intermittently hit a pulse open failure (desktop only — code-server
// sessions use the browser's Web Speech API instead, never this ffmpeg path).
const DEVICE_RELEASE_GRACE_MS = 250;

function ff(ffmpegPath: string): string {
    return ffmpegPath && ffmpegPath.trim() ? ffmpegPath.trim() : "ffmpeg";
}

/** First DirectShow audio capture device name (Windows). */
function firstDshowAudioDevice(bin: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const p = spawn(bin, [
            "-hide_banner",
            "-list_devices",
            "true",
            "-f",
            "dshow",
            "-i",
            "dummy",
        ]);
        let err = "";
        p.stderr.on("data", (d) => {
            err += d.toString();
        });
        p.on("error", (e) => reject(e));
        p.on("close", () => {
            // [dshow @ ...] "Microphone (Realtek ...)" (audio)
            const m = err.match(/"([^"]+)"\s*\(audio\)/);
            if (m) {
                resolve(m[1]);
            } else {
                reject(new Error("no audio input device found (dshow)"));
            }
        });
    });
}

async function inputArgs(bin: string): Promise<string[]> {
    if (process.platform === "win32") {
        const dev = await firstDshowAudioDevice(bin);
        return ["-f", "dshow", "-i", `audio=${dev}`];
    }
    if (process.platform === "darwin") {
        return ["-f", "avfoundation", "-i", ":0"];
    }
    // Linux and WSLg (PulseAudio socket is exported by WSLg).
    return ["-f", "pulse", "-i", "default"];
}

export function isCapturing(): boolean {
    return !!proc;
}

/**
 * Starts recording. Rejects fast when ffmpeg dies immediately (no device/permission).
 *
 * `onSilence`, when given, adds ffmpeg's own `silencedetect` filter (a
 * passthrough analysis filter — it doesn't touch the recorded audio) and
 * calls back on every sustained pause, parsed straight out of the SAME
 * process's stderr. Deliberately NOT a second ffmpeg process reading the mic
 * concurrently: the webview's getUserMedia-based VAD (src/ui/webview/voice.ts)
 * is unreliable in VS Code desktop for the exact same permission reason host
 * capture exists at all, so silence detection needs to ride along on the one
 * mic access that's actually known to work here.
 *
 * `onSpeech`, when given, fires on the SAME filter's `silence_end` marker —
 * i.e. real audio activity happened, as opposed to a still-silent capture.
 * Lets the caller distinguish "this continuous-mode auto-restart genuinely
 * captured new speech" from "nothing was said yet", which a fixed timeout
 * can't do reliably (the user reading back the transcript before clicking
 * Send routinely takes longer than any short timeout).
 */
export async function startCapture(
    ffmpegPath: string,
    onSilence?: () => void,
    onSpeech?: () => void,
): Promise<void> {
    if (stopping) {
        await stopping;
    }
    if (proc) {
        // There is only ever one legitimate capture at a time, so a proc still
        // set here is stale state — either a quick stop-then-start raced past
        // stopCapture()'s `stopping` guard (the webview posts messages without
        // waiting for the previous handler, and stopCapture's own `await
        // import(...)` gives a start request a window to run first), or the
        // webview reloaded/switched mid-recording without ever calling
        // stopCapture/cancelCapture. Either way, self-heal instead of wedging
        // every future recording until the extension host restarts.
        cancelCapture();
        if (stopping) {
            await stopping;
        }
    }
    const bin = ff(ffmpegPath);
    const args = await inputArgs(bin);
    const filterArgs = onSilence || onSpeech ? ["-af", "silencedetect=noise=-30dB:d=0.9"] : [];
    outPath = path.join(os.tmpdir(), `symposium-rec-${Date.now()}.wav`);
    const p = spawn(
        bin,
        ["-hide_banner", "-y", ...args, ...filterArgs, "-ac", "1", "-ar", "16000", outPath],
        { stdio: ["pipe", "ignore", "pipe"] },
    );
    proc = p;
    let err = "";
    p.stderr.on("data", (d) => {
        const chunk = d.toString();
        err += chunk;
        // ffmpeg logs "silence_start: <t>" once ~0.9s of continuous silence is
        // confirmed (the `d` param above) — exactly the "pause, cut the
        // segment" signal the caller wants, no separate timer needed here.
        if (onSilence && chunk.includes("silence_start")) {
            onSilence();
        }
        // "silence_end: <t> | silence_duration: <d>" logs when audio resumes
        // after a silent stretch — i.e. actual speech, not just an open mic.
        if (onSpeech && chunk.includes("silence_end")) {
            onSpeech();
        }
    });
    // Startup-only verification: reject if ffmpeg dies within the first
    // 700ms (no device/permission), resolve if it's still alive after that.
    // The error/close listeners MUST be removed once settled — otherwise
    // they stay attached to `p` and a later, perfectly successful stop
    // (stopCapture() closes ffmpeg gracefully once the user is done talking)
    // fires this SAME "close" listener too. For a short recording that ends
    // before the 700ms mark, this verification promise would still be
    // pending at that point, so the legitimate stop gets misreported as a
    // startup failure ("audio capture failed (ffmpeg code 0)" — code 0 is
    // success) even though the WAV was captured fine.
    await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
            clearTimeout(ok);
            p.off("error", onError);
            p.off("close", onClose);
        };
        const onError = (e: Error) => {
            cleanup();
            if (proc === p) {
                proc = null;
            }
            reject(e);
        };
        const onClose = (code: number | null) => {
            cleanup();
            if (proc === p) {
                proc = null;
                reject(
                    new Error(
                        `audio capture failed (ffmpeg code ${code}). ${err.split("\n").filter(Boolean).slice(-2).join(" ").trim()}`,
                    ),
                );
            }
        };
        const ok = setTimeout(() => {
            cleanup();
            resolve();
        }, 700);
        p.on("error", onError);
        p.on("close", onClose);
    });
}

/** Stops recording and returns the captured WAV path. */
export async function stopCapture(): Promise<string> {
    const p = proc;
    if (!p) {
        throw new Error("not recording");
    }
    let resolveStopped: (() => void) | undefined;
    const stopped = new Promise<void>((resolve) => {
        resolveStopped = resolve;
    });
    stopping = stopped;
    const finish = () => {
        // Grace period: see DEVICE_RELEASE_GRACE_MS above the process ends,
        // the audio server needs a moment to actually free the device.
        setTimeout(() => {
            if (proc === p) {
                proc = null;
            }
            if (stopping === stopped) {
                stopping = null;
            }
            resolveStopped?.();
        }, DEVICE_RELEASE_GRACE_MS);
    };
    await new Promise<void>((resolve) => {
        const done = setTimeout(() => {
            try {
                p.kill();
            } catch {
                /* gone */
            }
            finish();
            resolve();
        }, 3000); // hard cap
        p.on("close", () => {
            clearTimeout(done);
            finish();
            resolve();
        });
        try {
            p.stdin?.write("q");
        } catch {
            /* fall through to kill */
        }
        setTimeout(() => {
            try {
                p.kill();
            } catch {
                /* gone */
            }
        }, 1500);
    });
    if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 128) {
        throw new Error("no audio captured");
    }
    return outPath;
}

/** Aborts recording and discards the file. */
export function cancelCapture(): void {
    const p = proc;
    if (p) {
        let resolveStopped: (() => void) | undefined;
        const stopped = new Promise<void>((resolve) => {
            resolveStopped = resolve;
        });
        stopping = stopped;
        const finish = () => {
            // Grace period: see DEVICE_RELEASE_GRACE_MS.
            setTimeout(() => {
                if (proc === p) {
                    proc = null;
                }
                if (stopping === stopped) {
                    stopping = null;
                }
                resolveStopped?.();
            }, DEVICE_RELEASE_GRACE_MS);
        };
        const done = setTimeout(() => {
            try {
                p.kill();
            } catch {
                /* gone */
            }
            finish();
        }, 3000);
        p.once("close", () => {
            clearTimeout(done);
            finish();
        });
    }
    if (p) {
        try {
            p.stdin?.write("q");
        } catch {
            try {
                p.kill();
            } catch {
                /* gone */
            }
        }
    }
    setTimeout(() => {
        try {
            fs.unlinkSync(outPath);
        } catch {
            /* ignore */
        }
    }, 500);
}
