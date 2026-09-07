import { micBtn, voiceActivity, voiceActivityLabel, voiceLevel, voiceMeter } from "./dom";

export type VoiceUiState = "idle" | "opening" | "listening" | "speech" | "finalizing" | "error";

const LABELS: Record<VoiceUiState, string> = {
    idle: "Voice input",
    opening: "Opening microphone…",
    listening: "Listening…",
    speech: "Speech detected",
    finalizing: "Finalizing transcription…",
    error: "Voice input failed",
};

export function setVoiceUiState(state: VoiceUiState, detail?: string): void {
    const label = detail?.trim() || LABELS[state];
    const active = state !== "idle";
    voiceActivity.hidden = !active;
    voiceActivity.dataset.state = state;
    voiceActivityLabel.textContent = label;
    micBtn.title = active && state !== "error" ? `${label} Click to stop.` : label;
    micBtn.setAttribute("aria-label", micBtn.title);
    micBtn.setAttribute(
        "aria-pressed",
        state === "listening" || state === "speech" ? "true" : "false",
    );
    micBtn.disabled = state === "opening" || state === "finalizing";
    if (!active || state === "error") setVoiceLevel(-96);
}

export function setVoiceLevel(rmsDbFs: number): void {
    const normalized = Math.max(0, Math.min(1, (rmsDbFs + 60) / 60));
    voiceLevel.style.setProperty("--voice-level", normalized.toFixed(3));
    voiceMeter.setAttribute("role", "meter");
    voiceMeter.setAttribute("aria-valuemin", "0");
    voiceMeter.setAttribute("aria-valuemax", "100");
    voiceMeter.setAttribute("aria-valuenow", String(Math.round(normalized * 100)));
    voiceMeter.setAttribute("aria-label", "Microphone level");
}
