// Host-driven voice capture (native recorder or VS Code Speech bridge) keeps
// the webview in the neutral "opening" state until the host confirms the
// microphone is live; only then do recording visuals start (voiceHostConfirm).
import { micBtn } from "./dom";
import { postMessage } from "./vscode";
import { setStatus } from "./status";
import { showToast } from "./menus";
import { playStopSound } from "./voiceSounds";
import { getVoicePreferences } from "./voicePrefs";
import { shouldDiscardUntouchedContinuation } from "./voiceContinuation";
import { dispatchVoiceEnded, setVoiceInputValue } from "./voiceComposer";
import {
    beginHostVoiceSession,
    currentHostCaptureId,
    endHostVoiceSession,
    markHostVoiceFinalizing,
} from "./voiceHostSession";
import {
    armHostOpenWatchdog,
    clearHostOpenWatchdog,
    confirmHostVoiceCaptureStarted,
} from "./voiceHostConfirm";
import { setVoiceUiState } from "./voiceUi";
import type { VoiceDraft } from "./voiceDraft";

export type HostVoicePath = "host" | "vscode-speech";

export interface HostCaptureDeps {
    draft: VoiceDraft;
    isDictationActive(): boolean;
    setDictationActive(value: boolean): void;
    setDictationUseHost(value: boolean): void;
    setRecordingState(recording: boolean, path: HostVoicePath | null): void;
    setTranscribing(value: boolean): void;
}

export function createHostCapture(deps: HostCaptureDeps) {
    let hostRecording = false;
    // Track untouched automatic continuations so they can be cancelled without transcription.
    let currentCaptureIsContinuation = false;
    let hadSpeechThisSegment = false;

    function start(isContinuation = false): void {
        const prefs = getVoicePreferences();
        const captureId = beginHostVoiceSession();
        postMessage({ type: "voice-start", captureId, vad: deps.isDictationActive() });
        hostRecording = true;
        currentCaptureIsContinuation = isContinuation;
        hadSpeechThisSegment = false;
        deps.setRecordingState(true, prefs.vscodeSpeechBridge ? "vscode-speech" : "host");
        // Neutral wait state: no red, no start sound, no dots until capture is real.
        setVoiceUiState("opening");
        deps.draft.reset();
        setStatus("Opening microphone...");
        armHostOpenWatchdog(() => failOpen("The microphone did not respond in time."));
    }

    function stop(discardUntouchedContinuation = false): void {
        clearHostOpenWatchdog();
        const prefs = getVoicePreferences();
        // Only explicit stops may discard an untouched continuation; VAD evidence can be incomplete.
        const phantom = shouldDiscardUntouchedContinuation(
            discardUntouchedContinuation,
            currentCaptureIsContinuation,
            hadSpeechThisSegment,
        );
        hostRecording = false;
        deps.setRecordingState(false, null);
        if (!deps.isDictationActive()) {
            micBtn.classList.remove("recording");
        }
        deps.draft.stopDots();
        deps.draft.interim = "";
        if (phantom) {
            // No result will arrive, so release any deferred send immediately.
            setStatus("Ready");
            postMessage({ type: "voice-cancel", captureId: currentHostCaptureId() });
            endHostVoiceSession();
            dispatchVoiceEnded();
            return;
        }
        if (prefs.soundFeedback && !deps.isDictationActive()) playStopSound();
        setVoiceInputValue(deps.draft.base); // drop the dots animation text
        setStatus("Transcribing...");
        deps.setTranscribing(true);
        const captureId = markHostVoiceFinalizing();
        if (captureId) postMessage({ type: "voice-stop", captureId });
    }

    /** Host confirmed the microphone is live — recording visuals may start. */
    function confirmStarted(): void {
        if (!hostRecording) return;
        clearHostOpenWatchdog();
        confirmHostVoiceCaptureStarted(currentCaptureIsContinuation, deps.draft);
    }

    function failFromHost(error: unknown, captureId?: string): void {
        if (!hostRecording) return;
        clearHostOpenWatchdog();
        hostRecording = false;
        currentCaptureIsContinuation = false;
        deps.setRecordingState(false, null);
        deps.setDictationUseHost(false);
        micBtn.classList.remove("recording");
        deps.draft.stopDots();
        deps.draft.interim = "";
        setVoiceInputValue(deps.draft.base);
        setStatus("Ready");
        showToast(`Microphone capture failed: ${String(error || "unknown error")}`, "error");
        // Release deferred sends when a continuous-mode restart fails.
        deps.setDictationActive(false);
        endHostVoiceSession(captureId);
        setVoiceUiState("error", "Microphone capture failed");
        dispatchVoiceEnded();
    }

    function failOpen(reason: string): void {
        if (!hostRecording) return;
        hostRecording = false;
        currentCaptureIsContinuation = false;
        deps.setRecordingState(false, null);
        deps.setDictationUseHost(false);
        deps.setDictationActive(false);
        micBtn.classList.remove("recording");
        deps.draft.stopDots();
        deps.draft.interim = "";
        setVoiceInputValue(deps.draft.base);
        setStatus("Ready");
        // Abort the still-pending host open (e.g. a hung VS Code Speech session).
        postMessage({ type: "voice-cancel", captureId: currentHostCaptureId() });
        endHostVoiceSession();
        setVoiceUiState("error", reason);
        showToast(reason, "error");
        dispatchVoiceEnded();
    }

    return {
        start,
        stop,
        confirmStarted,
        failFromHost,
        markSpeech() {
            hadSpeechThisSegment = true;
        },
    };
}
