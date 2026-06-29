/**
 * Local STT engine runners. Each engine is an external CLI driven through
 * child_process; captured audio is first normalised to 16 kHz mono WAV with
 * ffmpeg, which every engine here accepts.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawn } from "child_process";

export interface RunResult {
    code: number;
    stdout: string;
    stderr: string;
}

/** Runs a command, capturing stdout/stderr. Never rejects on non-zero exit. */
function run(cmd: string, args: string[], cwd?: string): Promise<RunResult> {
    return new Promise((resolve) => {
        let stdout = "";
        let stderr = "";
        let child;
        try {
            child = spawn(cmd, args, { cwd });
        } catch (e) {
            resolve({ code: -1, stdout: "", stderr: String((e as Error).message) });
            return;
        }
        child.stdout.on("data", (d) => { stdout += d.toString(); });
        child.stderr.on("data", (d) => { stderr += d.toString(); });
        child.on("error", (e) => resolve({ code: -1, stdout, stderr: stderr + String(e.message) }));
        child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    });
}

/** True when the command is runnable (resolves a version/help without ENOENT). */
export async function commandAvailable(cmd: string): Promise<boolean> {
    if (!cmd || !cmd.trim()) { return false; }
    const r = await run(cmd, ["--help"]);
    // ENOENT surfaces as code -1 with an error message; anything else means it ran.
    return r.code !== -1;
}

function tmpFile(ext: string): string {
    return path.join(os.tmpdir(), `symposium-stt-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`);
}

/**
 * Decodes arbitrary captured audio (webm/opus, ogg, wav, ...) to 16 kHz mono
 * 16-bit WAV. Returns the wav path. Requires ffmpeg on PATH or an explicit path.
 */
export async function toWav16k(inputPath: string, ffmpegPath: string): Promise<string> {
    const out = tmpFile("wav");
    const ff = ffmpegPath && ffmpegPath.trim() ? ffmpegPath.trim() : "ffmpeg";
    const r = await run(ff, ["-y", "-i", inputPath, "-ar", "16000", "-ac", "1", "-f", "wav", out]);
    if (r.code !== 0 || !fs.existsSync(out)) {
        throw new Error(`ffmpeg conversion failed (code ${r.code}). ${r.stderr.split("\n").slice(-3).join(" ").trim()}`);
    }
    return out;
}

export interface WhisperCppOptions {
    binary: string;
    modelPath: string;
    language: string;        // 2-letter or "auto"
    threads: number;
    translate: boolean;
    beamSize: number;
    temperature: number;
    initialPrompt: string;
}

/** Runs whisper.cpp's whisper-cli and returns the transcript text. */
export async function transcribeWhisperCpp(wavPath: string, o: WhisperCppOptions): Promise<string> {
    if (!fs.existsSync(o.modelPath)) {
        throw new Error("whisper.cpp model not downloaded. Pick a model in Settings → Voice and download it.");
    }
    const args = [
        "-m", o.modelPath,
        "-f", wavPath,
        "-l", o.language || "auto",
        "-t", String(o.threads || 4),
        "-bs", String(o.beamSize || 5),
        "-tp", String(o.temperature || 0),
        "-nt",   // no timestamps: stdout is plain text
        "-np",   // no progress prints
    ];
    if (o.translate) { args.push("-tr"); }
    if (o.initialPrompt && o.initialPrompt.trim()) { args.push("--prompt", o.initialPrompt.trim()); }
    const r = await run(o.binary || "whisper-cli", args);
    if (r.code !== 0) {
        throw new Error(`whisper-cli failed (code ${r.code}). ${r.stderr.split("\n").slice(-3).join(" ").trim()}`);
    }
    return r.stdout.trim();
}

export interface FasterWhisperOptions {
    binary: string;
    model: string;           // model name; the tool fetches it
    language: string;
    device: string;          // cpu | cuda
    computeType: string;     // int8 | float16 | float32
    beamSize: number;
    vad: boolean;
}

/** Runs whisper-ctranslate2 (faster-whisper) and returns the transcript text. */
export async function transcribeFasterWhisper(wavPath: string, o: FasterWhisperOptions): Promise<string> {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "symposium-fw-"));
    const args = [
        wavPath,
        "--model", o.model || "base",
        "--output_format", "txt",
        "--output_dir", outDir,
        "--device", o.device || "cpu",
        "--compute_type", o.computeType || "int8",
        "--beam_size", String(o.beamSize || 5),
        "--vad_filter", o.vad ? "True" : "False",
    ];
    if (o.language && o.language !== "auto") { args.push("--language", o.language); }
    const r = await run(o.binary || "whisper-ctranslate2", args);
    if (r.code !== 0) {
        throw new Error(`whisper-ctranslate2 failed (code ${r.code}). ${r.stderr.split("\n").slice(-3).join(" ").trim()}`);
    }
    // Output file is named after the input stem.
    const stem = path.basename(wavPath).replace(/\.[^.]+$/, "");
    const txt = path.join(outDir, stem + ".txt");
    const text = fs.existsSync(txt) ? fs.readFileSync(txt, "utf8").trim() : r.stdout.trim();
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch { /* ignore */ }
    return text;
}

export interface VoskOptions {
    binary: string;
    modelPath: string;
}

/** Runs vosk-transcriber and returns the transcript text. */
export async function transcribeVosk(wavPath: string, o: VoskOptions): Promise<string> {
    if (!fs.existsSync(o.modelPath)) {
        throw new Error("Vosk model not downloaded. Pick a model in Settings → Voice and download it.");
    }
    const outTxt = tmpFile("txt");
    const args = ["-m", o.modelPath, "-i", wavPath, "-t", "text", "-o", outTxt];
    const r = await run(o.binary || "vosk-transcriber", args);
    if (r.code !== 0) {
        throw new Error(`vosk-transcriber failed (code ${r.code}). Install with 'pip install vosk'. ${r.stderr.split("\n").slice(-3).join(" ").trim()}`);
    }
    const text = fs.existsSync(outTxt) ? fs.readFileSync(outTxt, "utf8").trim() : r.stdout.trim();
    try { fs.unlinkSync(outTxt); } catch { /* ignore */ }
    return text;
}
