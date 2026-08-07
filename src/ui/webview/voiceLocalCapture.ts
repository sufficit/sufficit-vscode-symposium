import { postMessage } from "./vscode";
import { showToast } from "./menus";

export interface LocalCaptureHooks {
    onStarted: (isContinuation: boolean) => void;
    onStopping: () => void;
    onEmpty: () => void;
    onTranscribing: () => void;
    onStopFailed: () => void;
}

let recorder: MediaRecorder | null = null;
let stream: MediaStream | null = null;
let chunks: Blob[] = [];

function stopStream(): void {
    for (const track of stream?.getTracks() ?? []) track.stop();
    stream = null;
}

export async function startLocalCapture(
    isContinuation: boolean,
    hooks: LocalCaptureHooks,
): Promise<void> {
    try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
        showToast("Microphone unavailable: " + ((error as Error).message || error), "error");
        return;
    }
    chunks = [];
    try {
        recorder = new MediaRecorder(stream);
    } catch (error) {
        showToast("Recording not supported here: " + ((error as Error).message || error), "error");
        stopStream();
        return;
    }
    recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data?.size) chunks.push(event.data);
    };
    const activeRecorder = recorder;
    recorder.onstop = async () => {
        const blob = new Blob(chunks, { type: activeRecorder.mimeType || "audio/webm" });
        stopStream();
        if (!blob.size) {
            hooks.onEmpty();
            return;
        }
        hooks.onTranscribing();
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let binary = "";
        for (const byte of bytes) binary += String.fromCharCode(byte);
        postMessage({ type: "stt-transcribe", data: btoa(binary), mime: blob.type });
    };
    recorder.start();
    hooks.onStarted(isContinuation);
}

export function stopLocalCapture(hooks: LocalCaptureHooks): void {
    hooks.onStopping();
    try {
        if (recorder && recorder.state !== "inactive") recorder.stop();
    } catch {
        hooks.onStopFailed();
    }
}
