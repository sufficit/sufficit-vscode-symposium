import { postMessage } from "./vscode";
import { input, micBtn } from "./dom";
import { setStatus } from "./status";
import { showToast } from "./menus";
import { resizeInput } from "./inputSizing";
import { playStartSound, playStopSound } from "./voiceSounds";
import {
    applyRecognitionPreferences,
    chooseVoicePath,
    getVoicePreferences,
    updateMicVisibility,
} from "./voicePrefs";
import { shouldDiscardUntouchedContinuation } from "./voiceContinuation";
import { markComposerSpeechInput } from "./composerBridge";
import { startVadMonitor, stopVadMonitor } from "./voiceVad";
import { startLocalCapture, stopLocalCapture, type LocalCaptureHooks } from "./voiceLocalCapture";
import { VoiceDraft } from "./voiceDraft";
import type {
    SpeechRecognitionErrorEventLike,
    SpeechRecognitionEventLike,
    SpeechRecognitionLike,
} from "./voiceTypes";

let recognition: SpeechRecognitionLike | null = null;
let isRecording = false;
let webSpeechStartWatchdog: ReturnType<typeof setTimeout> | null = null;
let activeVoicePath: "webspeech" | "host" | "local" | "vscode-speech" | null = null;

let dictationActive = false;
let dictationUseHost = false;
// Capture has stopped, but its transcript has not arrived yet.
let transcriptionInFlight = false;

function setInputValue(value: string) {
    if (input.value === value) {
        return;
    }
    input.value = value;
    // Mark that this text came from speech (so the send payload carries speech: true).
    markComposerSpeechInput(true);
    resizeInput();
    setStatus();
}

const draft = new VoiceDraft(() => input.value, setInputValue);

window.addEventListener("message", (e) => {
    if (e.data && e.data.type === "setVoicePreferences") {
        // Keep visibility calculations on the preferences received by this early listener.
        window.voicePreferences = e.data.preferences;
        getVoicePreferences();
        applyRecognitionPreferences(recognition);
        updateMicVisibility(webSpeechSupported);
    }
});

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const webSpeechSupported = !!SpeechRecognition;

// Electron exposes SpeechRecognition even where its recognition service cannot start.
if (SpeechRecognition) {
    recognition = new SpeechRecognition();
    applyRecognitionPreferences(recognition);

    recognition.onstart = () => {
        if (webSpeechStartWatchdog) {
            clearTimeout(webSpeechStartWatchdog);
            webSpeechStartWatchdog = null;
        }
        const prefs = getVoicePreferences();
        isRecording = true;
        activeVoicePath = "webspeech";
        micBtn.classList.add("recording");
        setStatus("Listening...");
        if (prefs.soundFeedback) playStartSound();
        draft.reset();
        if (prefs.dotsAnimation) draft.startDots();
    };

    recognition.onend = () => {
        if (webSpeechStartWatchdog) {
            clearTimeout(webSpeechStartWatchdog);
            webSpeechStartWatchdog = null;
        }
        isRecording = false;
        activeVoicePath = null;
        micBtn.classList.remove("recording");
        setStatus("Ready");
        draft.stopDots();
        draft.render();
        dispatchVoiceEnded();
    };

    recognition.onresult = (event: SpeechRecognitionEventLike) => {
        let interimTranscript = "";
        let finalTranscript = "";

        for (let i = event.resultIndex; i < event.results.length; ++i) {
            if (event.results[i].isFinal) {
                finalTranscript += event.results[i][0].transcript + " ";
            } else {
                interimTranscript += event.results[i][0].transcript;
            }
        }

        if (finalTranscript) {
            draft.base = draft.base + finalTranscript;
            draft.interim = "";
            draft.render();
            setStatus("Listening...");
        } else if (interimTranscript) {
            draft.interim = interimTranscript;
            draft.render();
            setStatus("Listening...");
        }
    };

    recognition.onerror = (event: SpeechRecognitionErrorEventLike) => {
        if (webSpeechStartWatchdog) {
            clearTimeout(webSpeechStartWatchdog);
            webSpeechStartWatchdog = null;
        }
        const prefs = getVoicePreferences();
        isRecording = false;
        activeVoicePath = null;
        micBtn.classList.remove("recording");
        setStatus("Error: " + event.error);
        draft.stopDots();
        draft.render();
        if (prefs.soundFeedback) playStopSound();
        console.error("Speech recognition error:", event.error);
        dispatchVoiceEnded();
    };
}

let hostRecording = false;
// Track untouched automatic continuations so they can be cancelled without transcription.
let currentCaptureIsContinuation = false;
let hadSpeechThisSegment = false;

function startHostCapture(isContinuation = false) {
    const prefs = getVoicePreferences();
    postMessage({ type: "voice-start", vad: dictationActive });
    hostRecording = true;
    isRecording = true;
    activeVoicePath = prefs.vscodeSpeechBridge ? "vscode-speech" : "host";
    currentCaptureIsContinuation = isContinuation;
    hadSpeechThisSegment = false;
    micBtn.classList.add("recording");
    setStatus("Listening...");
    if (prefs.soundFeedback && !isContinuation) playStartSound();
    draft.reset();
    if (prefs.dotsAnimation) draft.startDots();
}

function stopHostCapture(discardUntouchedContinuation = false) {
    const prefs = getVoicePreferences();
    // Only explicit stops may discard an untouched continuation; VAD evidence can be incomplete.
    const phantom = shouldDiscardUntouchedContinuation(
        discardUntouchedContinuation,
        currentCaptureIsContinuation,
        hadSpeechThisSegment,
    );
    isRecording = false;
    hostRecording = false;
    activeVoicePath = null;
    if (!dictationActive) {
        micBtn.classList.remove("recording");
    }
    draft.stopDots();
    draft.interim = "";
    if (phantom) {
        // No result will arrive, so release any deferred send immediately.
        setStatus("Ready");
        postMessage({ type: "voice-cancel" });
        dispatchVoiceEnded();
        return;
    }
    if (prefs.soundFeedback && !dictationActive) playStopSound();
    setInputValue(draft.base); // drop the dots animation text
    setStatus("Transcribing...");
    transcriptionInFlight = true;
    postMessage({ type: "voice-stop" });
}

const localCaptureHooks: LocalCaptureHooks = {
    onStarted(isContinuation) {
        const prefs = getVoicePreferences();
        isRecording = true;
        activeVoicePath = "local";
        micBtn.classList.add("recording");
        setStatus("Listening...");
        if (prefs.soundFeedback && !isContinuation) playStartSound();
        draft.reset();
        if (prefs.dotsAnimation) draft.startDots();
    },
    onStopping() {
        const prefs = getVoicePreferences();
        if (prefs.soundFeedback && !dictationActive) playStopSound();
        isRecording = false;
        activeVoicePath = null;
        if (!dictationActive) micBtn.classList.remove("recording");
        draft.stopDots();
        transcriptionInFlight = true;
    },
    onEmpty() {
        transcriptionInFlight = false;
        setStatus("Ready");
    },
    onTranscribing() {
        setStatus("Transcribing...");
    },
    onStopFailed() {
        transcriptionInFlight = false;
    },
};

function onSilenceDetected(): void {
    if (!dictationActive || !isRecording) {
        return;
    }
    if (activeVoicePath === "host" || activeVoicePath === "vscode-speech") {
        stopHostCapture(false);
    } else if (activeVoicePath === "local") {
        stopLocalCapture(localCaptureHooks);
    }
}

function maybeContinueDictation(): void {
    if (!dictationActive) {
        dispatchVoiceEnded();
        return;
    }
    if (dictationUseHost) {
        startHostCapture(true);
    } else {
        void startLocalCapture(true, localCaptureHooks);
    }
}

window.addEventListener("message", (e) => {
    if (!e.data) {
        return;
    }
    if (e.data.type === "stt-result") {
        transcriptionInFlight = false;
        const text = (e.data.text || "").trim();
        draft.stopDots();
        draft.interim = "";
        setInputValue((draft.base ? draft.base.replace(/[.\s]*$/, " ") : "") + text);
        input.focus();
        setStatus("Ready");
        maybeContinueDictation();
    } else if (e.data.type === "stt-error") {
        transcriptionInFlight = false;
        draft.stopDots();
        draft.interim = "";
        if (draft.base) {
            setInputValue(draft.base);
        }
        setStatus("Ready");
        showToast("Transcription failed: " + (e.data.error || "unknown error"), "error");
        maybeContinueDictation();
    } else if (e.data.type === "voice-recording") {
        if (!e.data.ok && hostRecording) {
            hostRecording = false;
            isRecording = false;
            activeVoicePath = null;
            dictationUseHost = false;
            micBtn.classList.remove("recording");
            draft.stopDots();
            draft.interim = "";
            setInputValue(draft.base);
            // Preserve the native-capture error instead of reporting a webview permission error.
            setStatus("Ready");
            showToast(
                "Native microphone capture failed: " + (e.data.error || "unknown error"),
                "error",
            );
            // Release deferred sends when a continuous-mode restart fails.
            dictationActive = false;
            dispatchVoiceEnded();
        }
    } else if (e.data.type === "voice-silence") {
        onSilenceDetected();
    } else if (e.data.type === "voice-speech") {
        hadSpeechThisSegment = true;
    }
});

if (micBtn) {
    micBtn.addEventListener("click", () => {
        const prefs = getVoicePreferences();
        const path = chooseVoicePath(webSpeechSupported);
        if (path === "none") {
            showToast("Voice input is not available with the current configuration.", "error");
            return;
        }
        if (path === "webspeech") {
            if (!recognition) {
                showToast("Speech recognition not supported in this browser", "error");
                return;
            }
            recognition.lang = prefs.language;
            recognition.continuous = prefs.continuous;
            recognition.interimResults = prefs.interimResults;
            if (isRecording) {
                stopVoiceRecording();
            } else {
                try {
                    recognition.start();
                    if (webSpeechStartWatchdog) {
                        clearTimeout(webSpeechStartWatchdog);
                    }
                    webSpeechStartWatchdog = setTimeout(() => {
                        webSpeechStartWatchdog = null;
                        if (isRecording) {
                            return;
                        }
                        showToast(
                            prefs.hostCapture
                                ? 'Web Speech API did not respond (it only works in a real browser, not VS Code desktop) — switch "Speech-to-text engine" to a local engine in Config.'
                                : "Web Speech API did not respond. Check microphone permission for this page.",
                            "error",
                        );
                    }, 3000);
                } catch (err) {
                    showToast(
                        "Could not start Web Speech API: " + ((err as Error)?.message || err),
                        "error",
                    );
                }
            }
            return;
        }
        if (isRecording) {
            stopVoiceRecording();
        } else if (prefs.hostCapture || prefs.vscodeSpeechBridge) {
            // VS Code Speech uses the host protocol without the webview microphone.
            dictationActive = prefs.continuous;
            dictationUseHost = true;
            startHostCapture();
        } else {
            dictationActive = prefs.continuous;
            dictationUseHost = false;
            void startLocalCapture(false, localCaptureHooks);
            if (dictationActive) {
                void startVadMonitor(onSilenceDetected);
            }
        }
    });
}

updateMicVisibility(webSpeechSupported);

function dispatchVoiceEnded(): void {
    window.dispatchEvent(new Event("symposium-voice-ended"));
}

export function isVoiceRecording(): boolean {
    return isRecording;
}

/** True between a segment's capture stopping and its stt-result/stt-error landing. */
export function isVoiceTranscribing(): boolean {
    return transcriptionInFlight;
}

/** Prevents another automatic segment without cancelling the current transcript. */
export function endDictationMode(): void {
    dictationActive = false;
}

export function stopVoiceRecording(): void {
    dictationActive = false;
    stopVadMonitor();
    if (activeVoicePath === "webspeech" && recognition) {
        const prefs = getVoicePreferences();
        if (prefs.soundFeedback) playStopSound();
        recognition.stop();
    } else if (activeVoicePath === "host" || activeVoicePath === "vscode-speech") {
        stopHostCapture(true);
    } else if (activeVoicePath === "local") {
        stopLocalCapture(localCaptureHooks);
    }
}
