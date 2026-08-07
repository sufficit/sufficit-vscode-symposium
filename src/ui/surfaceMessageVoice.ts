/**
 * Voice + speech-to-text message handlers for the chat surface.
 *
 * Split out of surfaceMessages.ts so that file stays under the 400-line cap.
 * Each handler takes the surface deps bag and the inbound message, performs the
 * host-side action (native mic capture / transcription), and posts the result
 * back to the webview. Behavior is identical to the inline case bodies.
 */
import type { WebviewToHost } from "./protocol";
import type { SurfaceMessagesDeps } from "./surfaceMessagesTypes";

/** Handles voice-start/stop/cancel/stt-transcribe. Returns true if handled. */
export async function handleVoiceMessage(message: WebviewToHost, d: SurfaceMessagesDeps): Promise<boolean> {
    switch (message?.type) {
        case "voice-start": {
            try {
                const { readSettings } = await import("../voice/sttService");
                const settings = readSettings();
                if (settings.engine === "vscode-speech") {
                    const { startVscodeSpeechDictation } = await import("../voice/vscodeSpeechBridge");
                    const started = await startVscodeSpeechDictation(settings.language, d.restoreFocus);
                    if (!started) { return true; }
                } else {
                    // Native mic capture in the extension host (no webview
                    // getUserMedia — VS Code drops that permission on reload).
                    const { startCapture } = await import("../voice/recorder");
                    await startCapture(
                        settings.ffmpegPath,
                        message.vad ? () => d.post({ type: "voice-silence" }) : undefined,
                        message.vad ? () => d.post({ type: "voice-speech" }) : undefined,
                    );
                }
                d.post({ type: "voice-recording", ok: true });
            } catch (e) {
                d.post({ type: "voice-recording", ok: false, error: String((e && (e as Error).message) || e) });
            }
            return true;
        }
        case "voice-stop": {
            try {
                const { readSettings, transcribeWav } = await import("../voice/sttService");
                let text: string;
                if (readSettings().engine === "vscode-speech") {
                    const { stopVscodeSpeechDictation } = await import("../voice/vscodeSpeechBridge");
                    text = await stopVscodeSpeechDictation();
                } else {
                    const { stopCapture } = await import("../voice/recorder");
                    text = await transcribeWav(await stopCapture());
                }
                d.post({ type: "stt-result", text });
            } catch (e) {
                d.post({ type: "stt-error", error: String((e && (e as Error).message) || e) });
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
                cancelCapture();
            }
            return true;
        }
        case "stt-transcribe": {
            // Local hybrid path: the webview captured audio; transcribe it
            // offline with the configured engine and return the text.
            try {
                const { transcribeAudio } = await import("../voice/sttService");
                const text = await transcribeAudio(message.data, message.mime);
                d.post({ type: "stt-result", text });
            } catch (e) {
                d.post({ type: "stt-error", error: String((e && (e as Error).message) || e) });
            }
            return true;
        }
        default:
            return false;
    }
}
