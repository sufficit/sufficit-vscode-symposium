import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSttDiagnostic, SttDiagnosticSnapshot } from "../voice/sttDiagnostic";

const tr = (key: string, vars?: Record<string, string | number>) => {
    let value = key;
    if (vars) {
        for (const [name, replacement] of Object.entries(vars)) {
            value = value.replace(`{${name}}`, String(replacement));
        }
    }
    return value;
};

function snapshot(engine: SttDiagnosticSnapshot["settings"]["engine"]): SttDiagnosticSnapshot {
    return {
        availability: { ffmpeg: true, "whisper-cpp": true, "faster-whisper": true, vosk: true },
        settings: {
            engine,
            language: "pt-BR",
            modelsDir: "",
            ffmpegPath: "",
            whisper: {
                binaryPath: "",
                model: "base",
                threads: 4,
                translate: false,
                beamSize: 5,
                temperature: 0,
                initialPrompt: "",
            },
            fasterWhisper: {
                binaryPath: "",
                model: "base",
                device: "cpu",
                computeType: "int8",
                beamSize: 5,
                vad: true,
            },
            vosk: { binaryPath: "", model: "vosk-model-small-pt-0.3" },
        },
        models: [{ id: "base", engine: "whisper-cpp", installed: true }],
    };
}

test("stt diagnostic: webspeech reports browser check instead of local whisper checks", () => {
    const result = buildSttDiagnostic(snapshot("webspeech"), tr, true, true);

    assert.equal(result.ready, true);
    assert.deepEqual(
        result.steps.map((s) => s.id),
        ["webspeech"],
    );
    assert.equal(result.steps[0].label, "config.voice.diagnose.webspeech");
});

test("stt diagnostic: VS Code Speech uses provider availability only", () => {
    const state = snapshot("vscode-speech");
    state.availability["vscode-speech"] = true;
    const result = buildSttDiagnostic(state, tr, false, false);

    assert.equal(result.ready, true);
    assert.deepEqual(
        result.steps.map((s) => s.id),
        ["vscode-speech"],
    );
    assert.equal(result.steps[0].status, "ok");
    assert.equal(result.steps[0].action, undefined);
    assert.equal(result.steps[0].fix, "config.voice.diagnose.vscodeSpeechReady");
});

test("stt diagnostic: missing VS Code Speech offers the desktop install action", () => {
    const state = snapshot("vscode-speech");
    state.availability["vscode-speech"] = false;
    const result = buildSttDiagnostic(state, tr, false, false);

    assert.equal(result.ready, false);
    assert.equal(result.steps[0].action, "install-vscode-speech");
    assert.equal(result.steps[0].actionLabel, "config.voice.vscodeSpeech.install");
    assert.equal(result.steps[0].fix, "config.voice.diagnose.fixVscodeSpeech");
});

test("stt diagnostic: code-server explains VS Code Speech incompatibility without install", () => {
    const state = snapshot("vscode-speech");
    state.availability["vscode-speech"] = false;
    const result = buildSttDiagnostic(state, tr, false, true);

    assert.equal(result.ready, false);
    assert.equal(result.steps[0].action, undefined);
    assert.equal(result.steps[0].fix, "config.voice.diagnose.fixVscodeSpeechWeb");
});

test("stt diagnostic: unsupported webspeech returns actionable failure", () => {
    const result = buildSttDiagnostic(snapshot("webspeech"), tr, false, true);

    assert.equal(result.ready, false);
    assert.equal(result.steps[0].status, "fail");
    assert.equal(result.steps[0].fix, "config.voice.diagnose.fixWebspeech");
});

test("stt diagnostic: auto uses browser check when Web Speech is available", () => {
    const result = buildSttDiagnostic(snapshot("auto"), tr, true, true);

    assert.equal(result.ready, true);
    assert.deepEqual(
        result.steps.map((s) => s.id),
        ["webspeech"],
    );
});

test("stt diagnostic: local engines keep ffmpeg, binary and model checks", () => {
    const result = buildSttDiagnostic(snapshot("whisper-cpp"), tr, true);

    assert.equal(result.ready, true);
    assert.deepEqual(
        result.steps.map((s) => s.id),
        ["ffmpeg", "binary", "model"],
    );
});

// The SpeechRecognition constructor exists in Electron's bundled Chromium
// (webSpeechSupported=true) even though the service never actually starts in
// VS Code desktop — the diagnostic must not report "ready" just because the
// API is present, or it lies about a mic button that will silently do nothing.
test("stt diagnostic: webspeech supported but on desktop still fails, with a desktop-specific fix", () => {
    const result = buildSttDiagnostic(snapshot("webspeech"), tr, true, false);

    assert.equal(result.ready, false);
    assert.equal(result.steps[0].status, "fail");
    assert.equal(result.steps[0].fix, "config.voice.diagnose.fixWebspeechDesktop");
});

// In "auto" mode on desktop, canUseLocalStt() actually routes to a local
// engine at runtime (not Web Speech) — the diagnostic must check THAT path,
// not the browser-only one it happens to also be capable of detecting.
test("stt diagnostic: auto on desktop checks the local engine that will actually run, not webspeech", () => {
    const result = buildSttDiagnostic(snapshot("auto"), tr, true, false);

    assert.deepEqual(
        result.steps.map((s) => s.id),
        ["ffmpeg", "binary", "model"],
    );
});
