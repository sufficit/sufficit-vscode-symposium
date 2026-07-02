/**
 * STT routing and microphone capture coordination.
 */
import * as vscode from "vscode";
import { start, stop, cancel as cancelRecording } from "./recorder";

let recordingFilePath: string | null = null;
let isRecording = false;

/**
 * Start recording microphone via native host capture (ffmpeg).
 */
export async function startRecording(ffmpegPath: string): Promise<{ ok: boolean; path?: string; error?: string }> {
    if (isRecording) {
        return { ok: false, error: "recording already in progress" };
    }

    try {
        const path = await start(ffmpegPath);
        recordingFilePath = path;
        isRecording = true;
        return { ok: true, path };
    } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        return { ok: false, error: errMsg };
    }
}

/**
 * Stop recording and return the WAV file path.
 */
export async function stopRecording(): Promise<{ ok: boolean; path?: string | null; error?: string }> {
    if (!isRecording) {
        return { ok: false, error: "no recording in progress" };
    }

    try {
        const path = await stop();
        isRecording = false;
        const result = recordingFilePath;
        recordingFilePath = null;
        return { ok: true, path: result };
    } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        return { ok: false, error: errMsg };
    }
}

/**
 * Cancel recording and clean up the temporary file.
 */
export async function cancelRecordingSession(): Promise<{ ok: boolean; error?: string }> {
    if (!isRecording) {
        return { ok: false, error: "no recording in progress" };
    }

    try {
        await cancelRecording();
        isRecording = false;
        recordingFilePath = null;
        return { ok: true };
    } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        return { ok: false, error: errMsg };
    }
}

/**
 * Get the recording file path if recording is active.
 */
export function getRecordingFilePath(): string | null {
    return isRecording ? recordingFilePath : null;
}

/**
 * Check if a recording is currently in progress.
 */
export function isRecordingActive(): boolean {
    return isRecording;
}