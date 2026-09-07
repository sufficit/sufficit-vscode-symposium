import { postMessage } from "./vscode";
import { input, micBtn } from "./dom";
import { setStatus } from "./status";
import { showToast } from "./menus";
import { playStartSound, playStopSound } from "./voiceSounds";
import {
    applyRecognitionPreferences,
    chooseVoicePath,
    getVoicePreferences,
    updateMicVisibility,
} from "./voicePrefs";
import { shouldDiscardUntouchedContinuation } from "./voiceContinuation";
import { stopVadMonitor } from "./voiceVad";
import { startLocalCapture, stopLocalCapture } from "./voiceLocalCapture";
import { createLocalCaptureHooks } from "./voiceLocalLifecycle";
import { dispatchVoiceEnded, setVoiceInputValue } from "./voiceComposer";
import {
    armHostVoicePreviews,
    beginHostVoiceSession,
    currentHostCaptureId,
    endHostVoiceSession,
    handleHostVoiceTelemetry,
    isCurrentHostCapture,
    markHostVoiceFinalizing,
} from "./voiceHostSession";
import { setVoiceUiState } from "./voiceUi";
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

const draft = new VoiceDraft(() => input.value, setVoiceInputValue);

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
        setVoiceUiState("listening");
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
        setVoiceUiState("idle");
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
            setVoiceUiState("speech");
        } else if (interimTranscript) {
            draft.interim = interimTranscript;
            draft.render();
            setStatus("Listening...");
            setVoiceUiState("speech");
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
        setVoiceUiState("error", "Speech recognition failed");
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
    const captureId = beginHostVoiceSession();
    postMessage({ type: "voice-start", captureId, vad: dictationActive });
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
        postMessage({ type: "voice-cancel", captureId: currentHostCaptureId() });
        endHostVoiceSession();
        dispatchVoiceEnded();
        return;
    }
    if (prefs.soundFeedback && !dictationActive) playStopSound();
    setVoiceInputValue(draft.base); // drop the dots animation text
    setStatus("Transcribing...");
    transcriptionInFlight = true;
    const captureId = markHostVoiceFinalizing();
    if (captureId) postMessage({ type: "voice-stop", captureId });
}

const localCaptureHooks = createLocalCaptureHooks({
    draft,
    isDictationActive: () => dictationActive,
    setRecording(recording) {
        isRecording = recording;
        activeVoicePath = recording ? "local" : null;
    },
    setTranscribing(transcribing) {
        transcriptionInFlight = transcribing;
    },
    onSilence: onSilenceDetected,
});

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
    if (
        handleHostVoiceTelemetry(e.data, (text) => {
            draft.interim = previewSuffix(draft.base, text);
            draft.render();
            setStatus("Listening...");
        })
    ) {
        return;
    }
    if (e.data.type === "stt-result") {
        if (!isCurrentHostCapture(e.data.captureId)) return;
        transcriptionInFlight = false;
        const text = (e.data.text || "").trim();
        draft.stopDots();
        draft.interim = "";
        setVoiceInputValue((draft.base ? draft.base.replace(/[.\s]*$/, " ") : "") + text);
        input.focus();
        setStatus("Ready");
        endHostVoiceSession(e.data.captureId);
        setVoiceUiState("idle");
        maybeContinueDictation();
    } else if (e.data.type === "stt-error") {
        if (!isCurrentHostCapture(e.data.captureId)) return;
        transcriptionInFlight = false;
        draft.stopDots();
        draft.interim = "";
        if (draft.base) {
            setVoiceInputValue(draft.base);
        }
        setStatus("Ready");
        endHostVoiceSession(e.data.captureId);
        setVoiceUiState("error", "Transcription failed");
        showToast("Transcription failed: " + (e.data.error || "unknown error"), "error");
        maybeContinueDictation();
    } else if (e.data.type === "voice-recording") {
        if (!isCurrentHostCapture(e.data.captureId)) return;
        if (!e.data.ok && hostRecording) {
            hostRecording = false;
            isRecording = false;
            activeVoicePath = null;
            dictationUseHost = false;
            micBtn.classList.remove("recording");
            draft.stopDots();
            draft.interim = "";
            setVoiceInputValue(draft.base);
            // Preserve the native-capture error instead of reporting a webview permission error.
            setStatus("Ready");
            showToast(
                "Native microphone capture failed: " + (e.data.error || "unknown error"),
                "error",
            );
            // Release deferred sends when a continuous-mode restart fails.
            dictationActive = false;
            endHostVoiceSession(e.data.captureId);
            setVoiceUiState("error", "Microphone capture failed");
            dispatchVoiceEnded();
        } else if (e.data.ok && activeVoicePath === "host") {
            armHostVoicePreviews();
        }
    } else if (e.data.type === "voice-silence") {
        if (!isCurrentHostCapture(e.data.captureId)) return;
        onSilenceDetected();
    } else if (e.data.type === "voice-speech") {
        if (!isCurrentHostCapture(e.data.captureId)) return;
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
                    setVoiceUiState("opening");
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
                    setVoiceUiState("error", "Could not start speech recognition");
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
        }
    });
}

updateMicVisibility(webSpeechSupported);

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

function previewSuffix(base: string, preview: string): string {
    const clean = preview.trim();
    return base.trim() && clean ? ` ${clean}` : clean;
}
