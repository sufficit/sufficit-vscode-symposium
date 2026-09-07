import { postMessage } from "./vscode";
import { showToast } from "./menus";

const MICROPHONE_OPEN_TIMEOUT_MS = 8_000;
const RECORDER_STOP_TIMEOUT_MS = 1_500;
const RECORDER_TIMESLICE_MS = 250;

export interface LocalCaptureHooks {
    onStarted: (isContinuation: boolean, stream: MediaStream) => void;
    onStopping: () => void;
    onEmpty: () => void;
    onTranscribing: () => void;
    onStopFailed: () => void;
}

let recorder: MediaRecorder | null = null;
let stream: MediaStream | null = null;
let chunks: Blob[] = [];
let finalizeRecording: (() => void) | null = null;
let stopFallback: ReturnType<typeof setTimeout> | null = null;

function stopStream(target = stream): void {
    for (const track of target?.getTracks() ?? []) track.stop();
    if (target === stream) stream = null;
}

export async function startLocalCapture(
    isContinuation: boolean,
    hooks: LocalCaptureHooks,
): Promise<void> {
    if (recorder && recorder.state !== "inactive") {
        showToast("Microphone capture is already active.", "error");
        return;
    }
    try {
        stream = await openMicrophone();
    } catch (error) {
        showToast("Microphone unavailable: " + ((error as Error).message || error), "error");
        return;
    }
    chunks = [];
    try {
        recorder = createRecorder(stream);
    } catch (error) {
        showToast("Recording not supported here: " + ((error as Error).message || error), "error");
        stopStream();
        return;
    }

    const activeRecorder = recorder;
    let finalized = false;
    finalizeRecording = () => {
        if (finalized) return;
        finalized = true;
        clearStopFallback();
        finalizeRecording = null;
        recorder = null;
        void submitRecording(activeRecorder, hooks);
    };
    activeRecorder.ondataavailable = (event: BlobEvent) => {
        if (event.data?.size) chunks.push(event.data);
    };
    activeRecorder.onstop = () => finalizeRecording?.();
    activeRecorder.onerror = () => finalizeRecording?.();
    activeRecorder.start(RECORDER_TIMESLICE_MS);
    hooks.onStarted(isContinuation, stream);
}

export function stopLocalCapture(hooks: LocalCaptureHooks): void {
    hooks.onStopping();
    try {
        if (!recorder || recorder.state === "inactive") {
            finalizeRecording?.();
            return;
        }
        recorder.requestData();
        recorder.stop();
        clearStopFallback();
        stopFallback = setTimeout(() => finalizeRecording?.(), RECORDER_STOP_TIMEOUT_MS);
    } catch {
        clearStopFallback();
        stopStream();
        finalizeRecording = null;
        recorder = null;
        hooks.onStopFailed();
    }
}

async function submitRecording(
    activeRecorder: MediaRecorder,
    hooks: LocalCaptureHooks,
): Promise<void> {
    const blob = new Blob(chunks, { type: activeRecorder.mimeType || "audio/webm" });
    chunks = [];
    stopStream();
    if (!blob.size) {
        hooks.onEmpty();
        return;
    }
    hooks.onTranscribing();
    try {
        postMessage({ type: "stt-transcribe", data: await blobToBase64(blob), mime: blob.type });
    } catch (error) {
        hooks.onStopFailed();
        showToast(
            "Could not read microphone recording: " + ((error as Error).message || error),
            "error",
        );
    }
}

async function openMicrophone(): Promise<MediaStream> {
    const pending = navigator.mediaDevices.getUserMedia({
        audio: {
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
        },
    });
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
            timedOut = true;
            reject(new Error("microphone permission timed out"));
        }, MICROPHONE_OPEN_TIMEOUT_MS);
    });
    try {
        return await Promise.race([pending, timeout]);
    } finally {
        if (timer) clearTimeout(timer);
        if (timedOut)
            void pending.then((lateStream) => stopStream(lateStream)).catch(() => undefined);
    }
}

function createRecorder(captureStream: MediaStream): MediaRecorder {
    const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];
    const mimeType = candidates.find(
        (candidate) =>
            typeof MediaRecorder.isTypeSupported !== "function" ||
            MediaRecorder.isTypeSupported(candidate),
    );
    return mimeType
        ? new MediaRecorder(captureStream, { mimeType })
        : new MediaRecorder(captureStream);
}

function blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(reader.error || new Error("recording read failed"));
        reader.onload = () => {
            const result = String(reader.result || "");
            const separator = result.indexOf(",");
            if (separator >= 0) {
                resolve(result.slice(separator + 1));
            } else {
                reject(new Error("invalid audio data"));
            }
        };
        reader.readAsDataURL(blob);
    });
}

function clearStopFallback(): void {
    if (stopFallback) clearTimeout(stopFallback);
    stopFallback = null;
}
