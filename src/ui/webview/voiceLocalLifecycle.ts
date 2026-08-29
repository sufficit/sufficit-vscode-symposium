import { micBtn } from "./dom";
import { setStatus } from "./status";
import { playStartSound, playStopSound } from "./voiceSounds";
import type { VoiceDraft } from "./voiceDraft";
import type { LocalCaptureHooks } from "./voiceLocalCapture";
import { getVoicePreferences } from "./voicePrefs";
import { startVadMonitor, stopVadMonitor } from "./voiceVad";
import { setVoiceUiState } from "./voiceUi";

interface LocalCaptureLifecycleOptions {
    draft: VoiceDraft;
    isDictationActive: () => boolean;
    setRecording: (recording: boolean) => void;
    setTranscribing: (transcribing: boolean) => void;
    onSilence: () => void;
}

export function createLocalCaptureHooks(options: LocalCaptureLifecycleOptions): LocalCaptureHooks {
    return {
        onStarted(isContinuation, stream) {
            const prefs = getVoicePreferences();
            options.setRecording(true);
            micBtn.classList.add("recording");
            setStatus("Listening...");
            setVoiceUiState("listening");
            if (prefs.soundFeedback && !isContinuation) playStartSound();
            options.draft.reset();
            if (prefs.dotsAnimation) options.draft.startDots();
            if (options.isDictationActive()) void startVadMonitor(options.onSilence, stream);
        },
        onStopping() {
            stopVadMonitor();
            const prefs = getVoicePreferences();
            if (prefs.soundFeedback && !options.isDictationActive()) playStopSound();
            options.setRecording(false);
            if (!options.isDictationActive()) micBtn.classList.remove("recording");
            options.draft.stopDots();
            options.setTranscribing(true);
            setVoiceUiState("finalizing");
        },
        onEmpty() {
            options.setTranscribing(false);
            setStatus("Ready");
            setVoiceUiState("idle");
        },
        onTranscribing() {
            setStatus("Transcribing...");
        },
        onStopFailed() {
            options.setTranscribing(false);
            setVoiceUiState("error", "Could not stop microphone capture");
        },
    };
}
