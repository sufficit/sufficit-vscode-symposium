/**
 * Voice + speech-to-text message handlers for the chat surface.
 *
 * Split out of surfaceMessages.ts so that file stays under the 400-line cap.
 * Each handler takes the surface deps bag and the inbound message, performs the
 * host-side action (native mic capture / transcription), and posts the result
 * back to the webview. Behavior is identical to the inline case bodies.
 */
import type { WebviewToHost } from "../protocol/chat";
import type { SurfaceMessagesDeps } from "./surfaceMessagesTypes";

const previewJobs = new Map<string, Promise<void>>();

/** Handles voice capture and transcription messages. Returns true if handled. */
export async function handleVoiceMessage(
    message: WebviewToHost,
    d: SurfaceMessagesDeps,
): Promise<boolean> {
    switch (message?.type) {
        case "voice-start": {
            try {
                const { readSettings } = await import("../voice/sttService");
                const settings = readSettings();
                if (settings.engine === "vscode-speech") {
                    const { startVscodeSpeechDictation } =
                        await import("../voice/vscodeSpeechBridge");
                    const started = await startVscodeSpeechDictation(
                        settings.language,
                        d.restoreFocus,
                    );
                    if (!started) {
                        return true;
                    }
                } else {
                    // Native mic capture in the extension host (no webview
                    // getUserMedia — VS Code drops that permission on reload).
                    const { startCapture } = await import("../voice/recorder");
                    const status = await startCapture(
                        settings.ffmpegPath,
                        {
                            onStatus: (snapshot) => d.post({ type: "voice-status", ...snapshot }),
                            onSilence: message.vad
                                ? (captureId) => d.post({ type: "voice-silence", captureId })
                                : undefined,
                            onSpeech: message.vad
                                ? (captureId) => d.post({ type: "voice-speech", captureId })
                                : undefined,
                        },
                        message.captureId,
                    );
                    d.post({ type: "voice-status", ...status });
                }
                d.post({ type: "voice-recording", ok: true, captureId: message.captureId });
            } catch (e) {
                d.post({
                    type: "voice-recording",
                    ok: false,
                    captureId: message.captureId,
                    error: String((e && (e as Error).message) || e),
                });
            }
            return true;
        }
        case "voice-preview": {
            const existing = previewJobs.get(message.captureId);
            if (existing) {
                await existing;
                return true;
            }
            const job = runVoicePreview(message.captureId, d);
            previewJobs.set(message.captureId, job);
            try {
                await job;
            } finally {
                if (previewJobs.get(message.captureId) === job) {
                    previewJobs.delete(message.captureId);
                }
            }
            return true;
        }
        case "voice-stop": {
            try {
                await previewJobs.get(message.captureId);
                const { readSettings, transcribeWav } = await import("../voice/sttService");
                let text: string;
                if (readSettings().engine === "vscode-speech") {
                    const { stopVscodeSpeechDictation } =
                        await import("../voice/vscodeSpeechBridge");
                    text = await stopVscodeSpeechDictation();
                } else {
                    const { stopCapture } = await import("../voice/recorder");
                    text = await transcribeWav(await stopCapture());
                }
                d.post({ type: "stt-result", text, captureId: message.captureId, final: true });
            } catch (e) {
                d.post({
                    type: "stt-error",
                    captureId: message.captureId,
                    error: String((e && (e as Error).message) || e),
                });
            }
            return true;
        }
        case "voice-cancel": {
            const { readSettings } = await import("../voice/sttService");
            if (readSettings().engine === "vscode-speech") {
                const { cancelVscodeSpeechDictation } = await import("../voice/vscodeSpeechBridge");
                await cancelVscodeSpeechDictation();
            } else {
                const { cancelCapture } = await import("../voice/recorder");
                await cancelCapture();
            }
            return true;
        }
        case "stt-transcribe": {
            // Local hybrid path: the webview captured audio; transcribe it
            // offline with the configured engine and return the text.
            try {
                const { transcribeAudio } = await import("../voice/sttService");
                const text = await transcribeAudio(message.data, message.mime);
                d.post({
                    type: message.purpose === "preview" ? "voice-preview-result" : "stt-result",
                    captureId: message.captureId,
                    text,
                    final: message.purpose !== "preview",
                });
            } catch (e) {
                d.post({
                    type: message.purpose === "preview" ? "voice-preview-result" : "stt-error",
                    captureId: message.captureId,
                    error: String((e && (e as Error).message) || e),
                });
            }
            return true;
        }
        default:
            return false;
    }
}

async function runVoicePreview(captureId: string, d: SurfaceMessagesDeps): Promise<void> {
    const { finishCapturePreview, prepareCapturePreview } = await import("../voice/recorder");
    const preview = prepareCapturePreview();
    if (!preview || preview.captureId !== captureId) {
        d.post({ type: "voice-preview-result", captureId, text: "" });
        return;
    }
    try {
        const { transcribeWav } = await import("../voice/sttService");
        const text = await transcribeWav(preview.wavPath);
        d.post({
            type: "voice-preview-result",
            captureId,
            text: finishCapturePreview(preview, text, true),
        });
    } catch (e) {
        finishCapturePreview(preview, "", false);
        d.post({
            type: "voice-preview-result",
            captureId,
            error: String((e && (e as Error).message) || e),
        });
    }
}
