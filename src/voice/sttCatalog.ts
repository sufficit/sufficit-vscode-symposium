/**
 * Speech-to-text catalog: the engines Symposium can drive locally and the
 * models each one can download on demand.
 *
 * Design constraints:
 * - No native Node bindings. Every engine is an external CLI invoked through
 *   child_process, so the extension keeps shipping as a single bundled file.
 * - Models are plain HTTPS downloads (a single weight file for whisper.cpp, a
 *   zip archive for Vosk), fetched only when the user explicitly asks.
 *
 * The Web Speech API engine (browser-only, used by code-server) is handled in
 * the webview and is intentionally absent here — this module is the host-side
 * local-transcription path that also works in the Electron desktop build.
 */

/** Local STT engine ids. "webspeech" lives in the webview, listed for the picker only. */
export type SttEngineId = "auto" | "webspeech" | "whisper-cpp" | "faster-whisper" | "vosk";

/** How a downloaded model is materialised on disk. */
export type ModelArtifactKind = "file" | "zip";

export interface SttModelSpec {
    /** Stable id used in settings and on disk. */
    id: string;
    /** Engine that consumes this model. */
    engine: SttEngineId;
    /** Human label for the config panel. */
    label: string;
    /** Approximate download size, for the UI. */
    size: string;
    /** Coverage hint shown in the UI. */
    languages: string;
    /** Download URL. */
    url: string;
    /** A single weight file (whisper.cpp .bin) or a zip to extract (Vosk). */
    kind: ModelArtifactKind;
}

export interface SttEngineSpec {
    id: SttEngineId;
    label: string;
    /** One-line description for the picker. */
    description: string;
    /** Default external command when the user has not set an explicit path. */
    defaultCommand: string;
    /** Whether models are downloaded by Symposium (true) or by the tool itself (false). */
    managesModels: boolean;
}

export const STT_ENGINES: SttEngineSpec[] = [
    {
        id: "auto",
        label: "Automatic",
        description: "Web Speech in the browser (code-server), local whisper.cpp on desktop.",
        defaultCommand: "",
        managesModels: false,
    },
    {
        id: "webspeech",
        label: "Web Speech API (browser only)",
        description: "Built-in browser recognition. Works in code-server, not in VS Code desktop.",
        defaultCommand: "",
        managesModels: false,
    },
    {
        id: "whisper-cpp",
        label: "whisper.cpp (local, CPU)",
        description: "OpenAI Whisper via the whisper-cli binary. Offline, multilingual, CPU-friendly.",
        defaultCommand: "whisper-cli",
        managesModels: true,
    },
    {
        id: "faster-whisper",
        label: "faster-whisper (CTranslate2)",
        description: "Faster Whisper via whisper-ctranslate2. Models are fetched by the tool itself.",
        defaultCommand: "whisper-ctranslate2",
        managesModels: false,
    },
    {
        id: "vosk",
        label: "Vosk (local, streaming)",
        description: "Lightweight offline recognition via vosk-transcriber (pip install vosk).",
        defaultCommand: "vosk-transcriber",
        managesModels: true,
    },
];

const WHISPER_BASE = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";
const VOSK_BASE = "https://alphacephei.com/vosk/models";

/** whisper.cpp GGML weights. `.en` variants are English-only and a bit sharper for English. */
export const WHISPER_MODELS: SttModelSpec[] = [
    { id: "tiny", engine: "whisper-cpp", label: "tiny", size: "75 MB", languages: "99 languages", url: `${WHISPER_BASE}/ggml-tiny.bin`, kind: "file" },
    { id: "tiny.en", engine: "whisper-cpp", label: "tiny.en", size: "75 MB", languages: "English only", url: `${WHISPER_BASE}/ggml-tiny.en.bin`, kind: "file" },
    { id: "base", engine: "whisper-cpp", label: "base", size: "142 MB", languages: "99 languages", url: `${WHISPER_BASE}/ggml-base.bin`, kind: "file" },
    { id: "base.en", engine: "whisper-cpp", label: "base.en", size: "142 MB", languages: "English only", url: `${WHISPER_BASE}/ggml-base.en.bin`, kind: "file" },
    { id: "small", engine: "whisper-cpp", label: "small", size: "466 MB", languages: "99 languages", url: `${WHISPER_BASE}/ggml-small.bin`, kind: "file" },
    { id: "small.en", engine: "whisper-cpp", label: "small.en", size: "466 MB", languages: "English only", url: `${WHISPER_BASE}/ggml-small.en.bin`, kind: "file" },
    { id: "medium", engine: "whisper-cpp", label: "medium", size: "1.5 GB", languages: "99 languages", url: `${WHISPER_BASE}/ggml-medium.bin`, kind: "file" },
    { id: "medium.en", engine: "whisper-cpp", label: "medium.en", size: "1.5 GB", languages: "English only", url: `${WHISPER_BASE}/ggml-medium.en.bin`, kind: "file" },
    { id: "large-v3-turbo", engine: "whisper-cpp", label: "large-v3-turbo", size: "1.6 GB", languages: "99 languages", url: `${WHISPER_BASE}/ggml-large-v3-turbo.bin`, kind: "file" },
    { id: "large-v3", engine: "whisper-cpp", label: "large-v3", size: "3.1 GB", languages: "99 languages", url: `${WHISPER_BASE}/ggml-large-v3.bin`, kind: "file" },
];

/** Vosk model packs (zip archives that expand to a model directory). */
export const VOSK_MODELS: SttModelSpec[] = [
    { id: "vosk-model-small-pt-0.3", engine: "vosk", label: "Portuguese (small)", size: "31 MB", languages: "pt-BR / pt-PT", url: `${VOSK_BASE}/vosk-model-small-pt-0.3.zip`, kind: "zip" },
    { id: "vosk-model-small-en-us-0.15", engine: "vosk", label: "English US (small)", size: "40 MB", languages: "en-US", url: `${VOSK_BASE}/vosk-model-small-en-us-0.15.zip`, kind: "zip" },
    { id: "vosk-model-en-us-0.22", engine: "vosk", label: "English US (large)", size: "1.8 GB", languages: "en-US", url: `${VOSK_BASE}/vosk-model-en-us-0.22.zip`, kind: "zip" },
    { id: "vosk-model-small-es-0.42", engine: "vosk", label: "Spanish (small)", size: "39 MB", languages: "es", url: `${VOSK_BASE}/vosk-model-small-es-0.42.zip`, kind: "zip" },
    { id: "vosk-model-small-fr-0.22", engine: "vosk", label: "French (small)", size: "41 MB", languages: "fr", url: `${VOSK_BASE}/vosk-model-small-fr-0.22.zip`, kind: "zip" },
    { id: "vosk-model-small-de-0.15", engine: "vosk", label: "German (small)", size: "45 MB", languages: "de", url: `${VOSK_BASE}/vosk-model-small-de-0.15.zip`, kind: "zip" },
];

/** Every downloadable model across engines. */
export const ALL_MODELS: SttModelSpec[] = [...WHISPER_MODELS, ...VOSK_MODELS];

export function modelsForEngine(engine: SttEngineId): SttModelSpec[] {
    return ALL_MODELS.filter((m) => m.engine === engine);
}

export function findModel(id: string): SttModelSpec | undefined {
    return ALL_MODELS.find((m) => m.id === id);
}

/**
 * Maps a BCP-47 voice language tag (e.g. "pt-BR") to the 2-letter code Whisper
 * and Vosk expect (e.g. "pt"). Returns "auto" for empty/unknown input.
 */
export function toShortLang(bcp47: string): string {
    const code = (bcp47 || "").trim().toLowerCase().split(/[-_]/)[0];
    return code || "auto";
}
