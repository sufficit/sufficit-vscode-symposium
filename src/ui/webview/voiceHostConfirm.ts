// Host-driven capture (native recorder or the VS Code Speech bridge) must not
// look like recording before the microphone is actually live: the webview sits
// in the neutral "opening" state and only shows recording visuals once the host
// answers voice-recording ok.
import { micBtn } from "./dom";
import { setStatus } from "./status";
import { playStartSound } from "./voiceSounds";
import { getVoicePreferences } from "./voicePrefs";
import { setVoiceUiState } from "./voiceUi";
import type { VoiceDraft } from "./voiceDraft";

const HOST_OPEN_TIMEOUT_MS = 10_000;

let openWatchdog: ReturnType<typeof setTimeout> | undefined;

/** Recording visuals start only here, after the host confirmed the mic is live. */
export function confirmHostVoiceCaptureStarted(isContinuation: boolean, draft: VoiceDraft): void {
    clearHostOpenWatchdog();
    const prefs = getVoicePreferences();
    micBtn.classList.add("recording");
    setStatus("Listening...");
    setVoiceUiState("listening");
    if (prefs.soundFeedback && !isContinuation) playStartSound();
    if (prefs.dotsAnimation) draft.startDots();
}

/** Fails the opening phase if the host never confirms the microphone. */
export function armHostOpenWatchdog(onTimeout: () => void): void {
    clearHostOpenWatchdog();
    openWatchdog = setTimeout(() => {
        openWatchdog = undefined;
        onTimeout();
    }, HOST_OPEN_TIMEOUT_MS);
}

export function clearHostOpenWatchdog(): void {
    if (openWatchdog) clearTimeout(openWatchdog);
    openWatchdog = undefined;
}
