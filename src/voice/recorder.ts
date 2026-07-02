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

/** First avfoundation audio device name (macOS). */
function firstAvfoundationAudioDevice(bin: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const p = spawn(bin, ["-hide_banner", "-list_devices", "true", "-f", "avfoundation", "-i", ""]);
        let err = "";
        p.stderr.on("data", (d) => { err += d.toString(); });
        p.on("error", (e) => reject(e));
        p.on("close", () => {
            // [1] Built-in Microphone
            const m = err.match(/\[(\d+)\]\s+([^:\n]+)(?=\s*\[|\s*$)/);
            if (m) {
                // Find first audio device (pattern: [N] Name)
                const lines = err.split("\n");
                for (const line of lines) {
                    const match = line.match(/^\[(\d+)\]\s+([^:\n]+?)(?:\s*\[|$)/);
                    if (match) {
                        // Usually audio devices are listed first
                        if (line.includes("Microphone") || line.includes("Audio")) {
                            resolve(match[1]);
                            return;
                        }
                    }
                }
            }
            reject(new Error("no audio input device found (avfoundation)"));
        });
    });
}

/** First pulse audio device name (Linux). */
function firstPulseAudioDevice(bin: string): Promise<string> {
    return Promise.resolve("default"); // PulseAudio handles 'default' as system default
}

/**
 * Start recording microphone via ffmpeg.
 * @returns Promise resolving to the output WAV file path.
 */
export async function start(ffmpegPath: string): Promise<string> {
    if (proc) {
        throw new Error("recording already in progress");
    }

    const platform = os.platform();
    const bin = ff(ffmpegPath);
    let inputArgs: string[] = [];
    let outputArgs = [
        "-f", "wav",
        "-acodec", "pcm_s16le",
        "-ar", "16000",
        "-ac", "1",
        "-"
    ];

    // Create temp file for output
    const tmpDir = os.tmpdir();
    const timestamp = Date.now();
    outPath = path.join(tmpDir, `symposium_rec_${timestamp}.wav`);

    // Build input args based on platform
    switch (platform) {
        case "win32":
            // Windows: use dshow (DirectShow)
            try {
                const device = await firstDshowAudioDevice(bin);
                inputArgs = ["-f", "dshow", "-i", `audio=${device}`];
            } catch (e) {
                throw new Error(`failed to enumerate dshow devices: ${e}`);
            }
            break;

        case "darwin":
            // macOS: use avfoundation
            try {
                const device = await firstAvfoundationAudioDevice(bin);
                inputArgs = ["-f", "avfoundation", "-i", `${device}:0`];
            } catch (e) {
                throw new Error(`failed to enumerate avfoundation devices: ${e}`);
            }
            break;

        case "linux":
            // Linux: use pulseaudio
            inputArgs = ["-f", "pulse", "-i", "default"];
            break;

        default:
            throw new Error(`unsupported platform: ${platform}`);
    }

    // Spawn ffmpeg
    proc = spawn(bin, [...inputArgs, ...outputArgs], {
        stdio: ["ignore", "pipe", "pipe"]
    });

    // Create write stream for output
    const writeStream = fs.createWriteStream(outPath);

    // Pipe stdout to file
    if (proc.stdout) {
        proc.stdout.pipe(writeStream);
    }

    // Handle errors
    if (proc.stderr) {
        proc.stderr.on("data", (data) => {
            // Log ffmpeg stderr (may contain useful info)
            // console.debug("[recorder] ffmpeg:", data.toString());
        });
    }

    proc.on("error", (err) => {
        console.error("[recorder] ffmpeg error:", err);
        proc = null;
    });

    proc.on("close", (code) => {
        if (code !== 0 && code !== null) {
            console.error(`[recorder] ffmpeg exited with code ${code}`);
        }
        proc = null;
    });

    return outPath;
}

/**
 * Stop recording and return the output WAV file path.
 * @returns Promise resolving to the WAV file path, or null if no recording was in progress.
 */
export async function stop(): Promise<string | null> {
    if (!proc) {
        return null;
    }

    // Send SIGTERM to ffmpeg
    proc.kill("SIGTERM");

    // Wait for process to exit (with timeout)
    await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
            if (proc) {
                proc.kill("SIGKILL");
                proc = null;
                resolve();
            }
        }, 5000);

        const checkExit = () => {
            if (!proc) {
                clearTimeout(timeout);
                resolve();
            } else {
                setTimeout(checkExit, 100);
            }
        };

        checkExit();
    });

    return outPath;
}

/**
 * Cancel recording and clean up the temporary file.
 */
export async function cancel(): Promise<void> {
    const wasRecording = proc !== null;
    const filePath = outPath;

    await stop();

    if (wasRecording && filePath) {
        try {
            fs.unlinkSync(filePath);
        } catch (e) {
            // Ignore cleanup errors
        }
    }

    outPath = "";
}