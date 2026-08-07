import { micBtn } from "./dom";
import type { SpeechRecognitionLike } from "./voiceTypes";

export type VoicePath = "webspeech" | "local" | "none";

export interface VoicePreferences {
    language: string;
    continuous: boolean;
    interimResults: boolean;
    dotsAnimation: boolean;
    soundFeedback: boolean;
    engine: string;
    localStt: boolean;
    hostCapture: boolean;
    vscodeSpeechBridge: boolean;
}

let voicePreferences: VoicePreferences = {
    language: "pt-BR",
    continuous: true,
    interimResults: true,
    dotsAnimation: true,
    soundFeedback: true,
    engine: "auto",
    // Fail closed until the host has confirmed a usable local STT path.
    // Otherwise the microphone flashes/appears during webview startup even
    // when diagnostics will shortly report the voice configuration invalid.
    localStt: false,
    hostCapture: false,
    vscodeSpeechBridge: false,
};

export function getVoicePreferences(): VoicePreferences {
    const prefs = window.voicePreferences;
    if (prefs) {
        voicePreferences = {
            language: prefs.language || "pt-BR",
            continuous: prefs.continuous !== false,
            interimResults: prefs.interimResults !== false,
            dotsAnimation: prefs.dotsAnimation !== false,
            soundFeedback: prefs.soundFeedback !== false,
            engine: prefs.engine || "auto",
            localStt: prefs.localStt !== false,
            hostCapture: prefs.hostCapture === true,
            vscodeSpeechBridge: prefs.vscodeSpeechBridge === true,
        };
    }
    return voicePreferences;
}

export function applyRecognitionPreferences(recognition: SpeechRecognitionLike | null): void {
    if (!recognition) {
        return;
    }
    const prefs = getVoicePreferences();
    recognition.lang = prefs.language;
    recognition.continuous = prefs.continuous;
    recognition.interimResults = prefs.interimResults;
}

export function webSpeechWorksHere(prefs: VoicePreferences, webSpeechSupported: boolean): boolean {
    return webSpeechSupported && !prefs.hostCapture;
}

export function updateMicVisibility(webSpeechSupported: boolean): void {
    if (!micBtn) {
        return;
    }
    const prefs = getVoicePreferences();
    const canWebSpeech =
        webSpeechWorksHere(prefs, webSpeechSupported) &&
        (prefs.engine === "webspeech" || (prefs.engine === "auto" && !prefs.localStt));
    const canLocal = prefs.localStt && prefs.engine !== "webspeech";
    micBtn.style.display = canWebSpeech || canLocal ? "inline-flex" : "none";
}

export function chooseVoicePath(webSpeechSupported: boolean): VoicePath {
    const prefs = getVoicePreferences();
    if (prefs.localStt && prefs.engine !== "webspeech") {
        return "local";
    }
    if (
        webSpeechWorksHere(prefs, webSpeechSupported) &&
        (prefs.engine === "webspeech" || prefs.engine === "auto")
    ) {
        return "webspeech";
    }
    return "none";
}
