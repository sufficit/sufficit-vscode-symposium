import * as vscode from "vscode";
import { canUseLocalStt, usesVscodeSpeechBridge } from "../voice/sttRouting";
import { isLocalSttReady } from "../voice/sttService";

/** Push the conservative initial voice state, then enable local STT after its real readiness probe. */
export function pushVoicePreferences(post: (message: unknown) => void): void {
    const voiceCfg = vscode.workspace.getConfiguration("symposium");
    const engine = voiceCfg.get<string>("voice.engine", "auto");
    const isWebUi = vscode.env.uiKind === vscode.UIKind.Web;
    const localSttRequested = canUseLocalStt(engine, isWebUi);
    const preferences = {
        language: voiceCfg.get<string>("voice.language", "pt-BR"),
        continuous: voiceCfg.get<boolean>("voice.continuous", true),
        interimResults: voiceCfg.get<boolean>("voice.interimResults", true),
        dotsAnimation: voiceCfg.get<boolean>("voice.dotsAnimation", true),
        soundFeedback: voiceCfg.get<boolean>("voice.soundFeedback", true),
        engine,
        localStt: false,
        hostCapture: !isWebUi && !usesVscodeSpeechBridge(engine),
        vscodeSpeechBridge: usesVscodeSpeechBridge(engine),
    };
    post({ type: "setVoicePreferences", preferences });

    if (!localSttRequested) {
        return;
    }
    void isLocalSttReady().then((ready) => {
        if (ready) {
            post({ type: "setVoicePreferences", preferences: { ...preferences, localStt: true } });
        }
    });
}
