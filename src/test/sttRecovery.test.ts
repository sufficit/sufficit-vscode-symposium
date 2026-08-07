import { test } from "node:test";
import assert from "node:assert/strict";
import type { SttSettings } from "../voice/sttService";
import { buildSttRecoveryPrompt, getSttRecoveryTarget } from "../voice/sttRecovery";

function settings(engine: SttSettings["engine"] = "faster-whisper"): SttSettings {
    return {
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
            binaryPath:
                "/home/user/snap/code/250/.local/share/pipx/venvs/whisper-ctranslate2/bin/whisper-ctranslate2",
            model: "base",
            device: "cpu",
            computeType: "int8",
            beamSize: 5,
            vad: true,
        },
        vosk: {
            binaryPath: "",
            model: "vosk-model-small-pt-0.3",
        },
    };
}

test("STT recovery targets only the saved local winner", () => {
    const target = getSttRecoveryTarget(settings());

    assert.equal(target?.engine, "faster-whisper");
    assert.equal(target?.model, "base");
    assert.equal(target?.binary, "whisper-ctranslate2");
    assert.equal(target?.binarySetting, "symposium.voice.fasterWhisper.binaryPath");
});

test("STT recovery refuses modes that do not identify a local winner", () => {
    assert.equal(getSttRecoveryTarget(settings("auto")), undefined);
    assert.equal(getSttRecoveryTarget(settings("webspeech")), undefined);
    assert.equal(buildSttRecoveryPrompt(settings("auto")), undefined);
});

test("STT recovery handles VS Code Speech as a workbench provider", () => {
    const configured = settings("vscode-speech");
    const target = getSttRecoveryTarget(configured);
    const prompt = buildSttRecoveryPrompt(configured);

    assert.equal(target?.kind, "workbench-provider");
    assert.equal(target?.binary, "ms-vscode.vscode-speech");
    assert.equal(target?.modelSetting, "accessibility.voice.speechLanguage");
    assert.ok(prompt);
    assert.match(prompt, /NÃO tente fornecer WAV/);
    assert.match(prompt, /NÃO declare o áudio funcional sem uma gravação real/);
    assert.match(prompt, /symposium\.voice\.engine=vscode-speech/);
    assert.doesNotMatch(prompt, /Confirme ffmpeg/);
});

test("STT recovery prompt preserves the winner and forbids a new benchmark", () => {
    const prompt = buildSttRecoveryPrompt(settings());

    assert.ok(prompt);
    assert.match(prompt, /preserve engine=faster-whisper e model=base/);
    assert.match(prompt, /NÃO rode benchmark/);
    assert.match(prompt, /NÃO compare engines/);
    assert.match(prompt, /NÃO instale os outros engines/);
    assert.match(prompt, /\/snap\/code\/<número>\//);
    assert.match(prompt, /Faça UM teste funcional curto/);
    assert.doesNotMatch(prompt, /Garanta os 3 binários instalados/);
});
