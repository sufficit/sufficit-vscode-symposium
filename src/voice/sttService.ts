/**
 * Host-side speech-to-text facade.
 *
 * Single entry point the config panel and the chat surface talk to: reads the
 * `symposium.voice.*` settings, reports engine/model state for the UI, downloads
 * models on demand, and transcribes captured audio with the selected local
 * engine. The Web Speech path stays in the webview; this is the local fallback
 * that also works in the Electron desktop build.
 */
import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
    STT_ENGINES, ALL_MODELS, SttEngineId, SttModelSpec, findModel, toShortLang,
} from "./sttCatalog";
import {
    initModelStorage, modelsDir, modelPath, isInstalled, downloadModel, deleteModel, DownloadProgress,
} from "./sttModels";
import {
    toWav16k, transcribeWhisperCpp, transcribeFasterWhisper, transcribeVosk, commandAvailable,
} from "./sttEngines";

export interface SttSettings {
    engine: SttEngineId;
    language: string;
    modelsDir: string;
    ffmpegPath: string;
    whisper: { binaryPath: string; model: string; threads: number; translate: boolean; beamSize: number; temperature: number; initialPrompt: string };
    fasterWhisper: { binaryPath: string; model: string; device: string; computeType: string; beamSize: number; vad: boolean };
    vosk: { binaryPath: string; model: string };
}

export function initSttStorage(context: vscode.ExtensionContext): void {
    initModelStorage(context.globalStorageUri.fsPath);
}

export function readSettings(): SttSettings {
    const c = vscode.workspace.getConfiguration("symposium.voice");
    return {
        engine: c.get<SttEngineId>("engine", "auto"),
        language: c.get<string>("language", "pt-BR"),
        modelsDir: c.get<string>("modelsDir", ""),
        ffmpegPath: c.get<string>("ffmpegPath", ""),
        whisper: {
            binaryPath: c.get<string>("whisper.binaryPath", ""),
            model: c.get<string>("whisper.model", "base"),
            threads: c.get<number>("whisper.threads", 4),
            translate: c.get<boolean>("whisper.translate", false),
            beamSize: c.get<number>("whisper.beamSize", 5),
            temperature: c.get<number>("whisper.temperature", 0),
            initialPrompt: c.get<string>("whisper.initialPrompt", ""),
        },
        fasterWhisper: {
            binaryPath: c.get<string>("fasterWhisper.binaryPath", ""),
            model: c.get<string>("fasterWhisper.model", "base"),
            device: c.get<string>("fasterWhisper.device", "cpu"),
            computeType: c.get<string>("fasterWhisper.computeType", "int8"),
            beamSize: c.get<number>("fasterWhisper.beamSize", 5),
            vad: c.get<boolean>("fasterWhisper.vad", true),
        },
        vosk: {
            binaryPath: c.get<string>("vosk.binaryPath", ""),
            model: c.get<string>("vosk.model", "vosk-model-small-pt-0.3"),
        },
    };
}

function resolvedRoot(s: SttSettings): string {
    return modelsDir(s.modelsDir);
}

/** Picks the concrete local engine to run. "auto"/"webspeech" fall back to whisper.cpp on the host. */
function resolveLocalEngine(s: SttSettings): SttEngineId {
    if (s.engine === "whisper-cpp" || s.engine === "faster-whisper" || s.engine === "vosk") { return s.engine; }
    return "whisper-cpp";
}

/** Snapshot for the config panel: engines, models (with installed flag), and tool availability. */
export async function getSttState(): Promise<Record<string, unknown>> {
    const s = readSettings();
    const root = resolvedRoot(s);
    const cmd = (fallback: string, override: string) => (override && override.trim() ? override.trim() : fallback);
    const [ffmpegOk, whisperOk, fasterOk, voskOk] = await Promise.all([
        commandAvailable(s.ffmpegPath && s.ffmpegPath.trim() ? s.ffmpegPath.trim() : "ffmpeg"),
        commandAvailable(cmd("whisper-cli", s.whisper.binaryPath)),
        commandAvailable(cmd("whisper-ctranslate2", s.fasterWhisper.binaryPath)),
        commandAvailable(cmd("vosk-transcriber", s.vosk.binaryPath)),
    ]);
    const models = ALL_MODELS.map((m) => ({
        id: m.id, engine: m.engine, label: m.label, size: m.size, languages: m.languages,
        installed: isInstalled(m, root),
    }));
    return {
        settings: s,
        modelsDir: root,
        engines: STT_ENGINES,
        models,
        availability: { ffmpeg: ffmpegOk, "whisper-cpp": whisperOk, "faster-whisper": fasterOk, vosk: voskOk },
    };
}

/** Downloads a model by id, forwarding progress. Returns the installed path. */
export async function downloadSttModel(modelId: string, onProgress: (p: DownloadProgress) => void): Promise<string> {
    const s = readSettings();
    return downloadModel(modelId, resolvedRoot(s), onProgress);
}

export function deleteSttModel(modelId: string): boolean {
    const s = readSettings();
    return deleteModel(modelId, resolvedRoot(s));
}

function specPath(spec: SttModelSpec, s: SttSettings): string {
    return modelPath(spec, resolvedRoot(s));
}

/**
 * Transcribes a base64 audio payload (whatever the webview captured) with the
 * configured local engine. Converts to 16 kHz mono WAV first. Cleans up temps.
 */
export async function transcribeAudio(base64: string, mime: string): Promise<string> {
    const s = readSettings();
    const engine = resolveLocalEngine(s);
    const lang = toShortLang(s.language);

    const ext = mime.includes("ogg") ? "ogg" : mime.includes("wav") ? "wav" : "webm";
    const input = path.join(os.tmpdir(), `symposium-stt-in-${Date.now()}.${ext}`);
    fs.writeFileSync(input, Buffer.from(base64, "base64"));

    let wav = "";
    try {
        wav = await toWav16k(input, s.ffmpegPath);
        if (engine === "whisper-cpp") {
            const spec = findModel(s.whisper.model);
            return await transcribeWhisperCpp(wav, {
                binary: s.whisper.binaryPath || "whisper-cli",
                modelPath: spec ? specPath(spec, s) : "",
                language: lang,
                threads: s.whisper.threads,
                translate: s.whisper.translate,
                beamSize: s.whisper.beamSize,
                temperature: s.whisper.temperature,
                initialPrompt: s.whisper.initialPrompt,
            });
        }
        if (engine === "faster-whisper") {
            return await transcribeFasterWhisper(wav, {
                binary: s.fasterWhisper.binaryPath || "whisper-ctranslate2",
                model: s.fasterWhisper.model,
                language: lang,
                device: s.fasterWhisper.device,
                computeType: s.fasterWhisper.computeType,
                beamSize: s.fasterWhisper.beamSize,
                vad: s.fasterWhisper.vad,
            });
        }
        // vosk
        const spec = findModel(s.vosk.model);
        return await transcribeVosk(wav, {
            binary: s.vosk.binaryPath || "vosk-transcriber",
            modelPath: spec ? specPath(spec, s) : "",
        });
    } finally {
        try { fs.unlinkSync(input); } catch { /* ignore */ }
        if (wav) { try { fs.unlinkSync(wav); } catch { /* ignore */ } }
    }
}
