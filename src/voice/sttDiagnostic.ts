import type { SttEngineId } from "./sttCatalog";
import type { SttSettings } from "./sttService";
import { canUseLocalStt } from "./sttRouting";

export interface DiagnoseStep {
    id: string;
    status: "ok" | "fail";
    label: string;
    fix?: string;
    downloadable?: string[];
    action?: "install-vscode-speech";
    actionLabel?: string;
}

export interface DiagnoseResult {
    ready: boolean;
    steps: DiagnoseStep[];
}

export interface SttDiagnosticSnapshot {
    availability: Record<string, boolean>;
    settings: SttSettings;
    models: { id: string; engine: string; installed: boolean }[];
}

export type DiagnosticTranslator = (key: string, vars?: Record<string, string | number>) => string;

export function buildSttDiagnostic(
    stt: SttDiagnosticSnapshot,
    tr: DiagnosticTranslator,
    webSpeechSupported?: boolean,
    // True in a real browser (code-server); false in VS Code desktop
    // (Electron). Same signal canUseLocalStt()/chatSurface.ts already use to
    // decide which path actually runs — reused here so the diagnostic mirrors
    // reality instead of re-deriving its own (previously diverging) rule.
    isWebUi?: boolean,
): DiagnoseResult {
    // Whichever path canUseLocalStt() says WON'T be used locally is the one
    // that's actually going to run when the mic is clicked.
    const usesLocal = canUseLocalStt(stt.settings.engine, isWebUi === true);
    if (!usesLocal) {
        // The SpeechRecognition constructor exists in Electron's bundled
        // Chromium, but the recognition service never actually starts there
        // (confirmed: neither onstart nor onerror ever fires) — so on desktop
        // this must NOT report "ready" just because the API is present.
        const worksHere = webSpeechSupported !== false && isWebUi === true;
        const steps: DiagnoseStep[] = [
            {
                id: "webspeech",
                status: worksHere ? "ok" : "fail",
                label: tr("config.voice.diagnose.webspeech"),
                fix: worksHere
                    ? undefined
                    : tr(
                          isWebUi === false
                              ? "config.voice.diagnose.fixWebspeechDesktop"
                              : "config.voice.diagnose.fixWebspeech",
                      ),
            },
        ];
        return { ready: worksHere, steps };
    }

    const avail = stt.availability || {};
    const settings = stt.settings;
    if (settings.engine === "vscode-speech") {
        const available = avail["vscode-speech"] === true;
        const supported = isWebUi !== true;
        return {
            ready: available,
            steps: [
                {
                    id: "vscode-speech",
                    status: available ? "ok" : "fail",
                    label: tr("config.voice.diagnose.vscodeSpeech"),
                    fix: available
                        ? tr("config.voice.diagnose.vscodeSpeechReady")
                        : tr(
                              supported
                                  ? "config.voice.diagnose.fixVscodeSpeech"
                                  : "config.voice.diagnose.fixVscodeSpeechWeb",
                          ),
                    action: !available && supported ? "install-vscode-speech" : undefined,
                    actionLabel:
                        !available && supported
                            ? tr("config.voice.vscodeSpeech.install")
                            : undefined,
                },
            ],
        };
    }
    const models = stt.models || [];
    const engine = resolveDiagnosticLocalEngine(settings.engine);

    const steps: DiagnoseStep[] = [];

    steps.push({
        id: "ffmpeg",
        status: avail.ffmpeg ? "ok" : "fail",
        label: tr("config.voice.diagnose.ffmpeg"),
        fix: avail.ffmpeg ? undefined : tr("config.voice.diagnose.fixFfmpeg"),
    });

    const binaryOk = !!avail[engine];
    const binaryPath =
        engine === "whisper-cpp"
            ? settings.whisper.binaryPath
            : engine === "faster-whisper"
              ? settings.fasterWhisper.binaryPath
              : settings.vosk.binaryPath;
    steps.push({
        id: "binary",
        status: binaryOk ? "ok" : "fail",
        label: tr("config.voice.diagnose.binary", { engine }),
        fix: binaryOk
            ? undefined
            : tr("config.voice.diagnose.fixBinary", {
                  engine,
                  path: binaryPath || engine,
                  // The 3 engines are entirely different tools (apt package vs 2
                  // separate pip packages) — a single hardcoded suggestion would be
                  // wrong for whichever engine ISN'T whisper.cpp, so it's picked here.
                  hint: installHintFor(engine),
              }),
    });

    let modelOk = engine === "faster-whisper";
    let downloadable: string[] | undefined;
    if (!modelOk) {
        const forEngine = models.filter((m) => m.engine === engine);
        modelOk = forEngine.some((m) => m.installed);
        if (!modelOk) {
            downloadable = forEngine.map((m) => m.id);
        }
    }
    steps.push({
        id: "model",
        status: modelOk ? "ok" : "fail",
        label: tr("config.voice.diagnose.model", { engine }),
        fix: modelOk ? undefined : tr("config.voice.diagnose.fixModel"),
        downloadable,
    });

    return { ready: steps.every((s) => s.status === "ok"), steps };
}

function resolveDiagnosticLocalEngine(
    engine: SttEngineId,
): "whisper-cpp" | "faster-whisper" | "vosk" {
    if (engine === "faster-whisper" || engine === "vosk") {
        return engine;
    }
    return "whisper-cpp";
}

/** Install command per engine — same phrasing already used elsewhere for these
 *  tools (sttCatalog.ts descriptions, sttEngines.ts's own runtime error text). */
function installHintFor(engine: "whisper-cpp" | "faster-whisper" | "vosk"): string {
    if (engine === "faster-whisper") {
        return "pip install whisper-ctranslate2";
    }
    if (engine === "vosk") {
        return "pip install vosk";
    }
    return "sudo apt-get install -y whisper.cpp";
}
