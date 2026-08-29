import { postMessage } from "./vscode";
import { setVoiceLevel, setVoiceUiState } from "./voiceUi";

const PREVIEW_REQUEST_INTERVAL_MS = 2_000;

let captureId: string | undefined;
let previewTimer: ReturnType<typeof setTimeout> | undefined;
let previewPending = false;
let finalizing = false;

export function beginHostVoiceSession(): string {
    endHostVoiceSession();
    captureId = createCaptureId();
    finalizing = false;
    setVoiceUiState("opening");
    return captureId;
}

export function armHostVoicePreviews(): void {
    if (!captureId || finalizing) return;
    schedulePreview();
}

export function markHostVoiceFinalizing(): string | undefined {
    clearPreviewTimer();
    previewPending = false;
    finalizing = true;
    if (captureId) setVoiceUiState("finalizing");
    return captureId;
}

export function endHostVoiceSession(expectedCaptureId?: string): void {
    if (expectedCaptureId && captureId && expectedCaptureId !== captureId) return;
    clearPreviewTimer();
    previewPending = false;
    finalizing = false;
    captureId = undefined;
    setVoiceUiState("idle");
}

export function currentHostCaptureId(): string | undefined {
    return captureId;
}

export function isCurrentHostCapture(candidate: unknown): boolean {
    if (typeof candidate !== "string") return true;
    return !!captureId && candidate === captureId;
}

export function handleHostVoiceTelemetry(
    data: Record<string, unknown>,
    onPreview: (text: string) => void,
): boolean {
    if (data.type === "voice-status") {
        if (!isCurrentHostCapture(data.captureId)) return true;
        const rms = typeof data.rmsDbFs === "number" ? data.rmsDbFs : -96;
        setVoiceLevel(rms);
        if (data.lastError) {
            setVoiceUiState("error", String(data.lastError));
        } else if (data.recording && !finalizing) {
            const provider = typeof data.providerLabel === "string" ? data.providerLabel : "";
            setVoiceUiState(data.hasSpeech ? "speech" : "listening", provider || undefined);
        }
        return true;
    }
    if (data.type === "voice-preview-result") {
        if (!isCurrentHostCapture(data.captureId)) return true;
        previewPending = false;
        if (finalizing) return true;
        if (typeof data.text === "string" && data.text.trim()) onPreview(data.text.trim());
        if (captureId) schedulePreview();
        return true;
    }
    return false;
}

function schedulePreview(): void {
    clearPreviewTimer();
    previewTimer = setTimeout(() => {
        previewTimer = undefined;
        if (!captureId || previewPending) return;
        previewPending = true;
        postMessage({ type: "voice-preview", captureId });
        // A dropped host response must not permanently disable live previews.
        previewTimer = setTimeout(() => {
            previewTimer = undefined;
            previewPending = false;
            if (captureId) schedulePreview();
        }, 15_000);
    }, PREVIEW_REQUEST_INTERVAL_MS);
}

function clearPreviewTimer(): void {
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = undefined;
}

function createCaptureId(): string {
    if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
