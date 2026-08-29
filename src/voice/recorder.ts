/** Provider-neutral host microphone capture with bounded PCM and live telemetry. */
import { ChildProcessWithoutNullStreams, spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
    buildVoiceCaptureCandidates,
    executableExists,
    VoiceCaptureCandidate,
} from "./voiceCaptureProviders";
import {
    DEFAULT_VOICE_AUDIO_OPTIONS,
    encodePcm16Wave,
    VoiceAudioBuffer,
    VoiceAudioMetrics,
} from "./voiceAudioBuffer";

const CAPTURE_STARTUP_TIMEOUT_MS = 2_000;
const STATUS_INTERVAL_MS = 100;
const PREVIEW_MINIMUM_AUDIO_MS = 700;
const PREVIEW_MINIMUM_INTERVAL_MS = 1_500;
const PREVIEW_MAXIMUM_INTERVAL_MS = 4_000;
const PREVIEW_SEGMENT_MAXIMUM_SECONDS = 12;

export interface VoiceCaptureStatus extends VoiceAudioMetrics {
    captureId: string;
    recording: boolean;
    provider?: string;
    providerLabel?: string;
    device?: string;
    availableProviders: string[];
    lastError?: string;
}

export interface VoiceCaptureCallbacks {
    onStatus?: (status: VoiceCaptureStatus) => void;
    onSilence?: (captureId: string) => void;
    onSpeech?: (captureId: string) => void;
}

export interface PreparedVoicePreview {
    captureId: string;
    leaseId: number;
    wavPath: string;
}

interface CaptureSession {
    captureId: string;
    candidate: VoiceCaptureCandidate;
    availableProviders: string[];
    child: ChildProcessWithoutNullStreams;
    buffer: VoiceAudioBuffer;
    callbacks: VoiceCaptureCallbacks;
    stderr: string;
    stopping: boolean;
    lastStatusAt: number;
    lastError?: string;
    committedBytes: number;
    committedText: string;
    lastPreviewAt: number;
    previewLease?: number;
}

interface PreviewLease {
    session: CaptureSession;
    endOffset: number;
    commit: boolean;
}

let activeSession: CaptureSession | undefined;
let stopping: Promise<void> | undefined;
let nextPreviewLease = 1;
const previewLeases = new Map<number, PreviewLease>();

export function isCapturing(): boolean {
    return !!activeSession;
}

export async function startCapture(
    ffmpegPath: string,
    callbacks: VoiceCaptureCallbacks = {},
    captureId = createCaptureId(),
): Promise<VoiceCaptureStatus> {
    if (stopping) await stopping;
    if (activeSession) await cancelCapture();

    const candidates = await availableCandidates(ffmpegPath);
    const errors: string[] = [];
    for (const candidate of candidates) {
        try {
            const session = await startCandidate(candidate, candidates, callbacks, captureId);
            activeSession = session;
            emitStatus(session, true);
            return statusOf(session, true);
        } catch (error) {
            errors.push(`${candidate.id}: ${messageOf(error)}`);
        }
    }
    const detail = errors.length
        ? errors.join(" | ")
        : "No supported microphone capture provider is installed.";
    throw new Error(detail);
}

export function prepareCapturePreview(now = Date.now()): PreparedVoicePreview | undefined {
    const session = activeSession;
    if (!session || session.previewLease !== undefined) return undefined;
    const metrics = session.buffer.metrics();
    const segmentBytes = metrics.capturedBytes - session.committedBytes;
    const bytesPerSecond = DEFAULT_VOICE_AUDIO_OPTIONS.sampleRate * 2;
    const minimumBytes = (bytesPerSecond * PREVIEW_MINIMUM_AUDIO_MS) / 1000;
    if (!metrics.hasSpeech || segmentBytes < minimumBytes) return undefined;

    const sinceLast = session.lastPreviewAt ? now - session.lastPreviewAt : Infinity;
    if (sinceLast < PREVIEW_MINIMUM_INTERVAL_MS) return undefined;
    if (session.lastPreviewAt && !metrics.isSilent && sinceLast < PREVIEW_MAXIMUM_INTERVAL_MS) {
        return undefined;
    }

    const endOffset = metrics.capturedBytes;
    const segment = session.buffer.slice(session.committedBytes, endOffset);
    const wavPath = writeTemporaryWave(segment, "preview");
    const segmentSeconds = segmentBytes / bytesPerSecond;
    const leaseId = nextPreviewLease++;
    session.previewLease = leaseId;
    session.lastPreviewAt = now;
    previewLeases.set(leaseId, {
        session,
        endOffset,
        commit: metrics.isSilent || segmentSeconds >= PREVIEW_SEGMENT_MAXIMUM_SECONDS,
    });
    return { captureId: session.captureId, leaseId, wavPath };
}

export function finishCapturePreview(
    preview: PreparedVoicePreview,
    text: string,
    succeeded: boolean,
): string {
    const lease = previewLeases.get(preview.leaseId);
    previewLeases.delete(preview.leaseId);
    if (!lease) return "";
    const { session } = lease;
    if (session.previewLease === preview.leaseId) session.previewLease = undefined;
    const clean = text.trim();
    if (succeeded && clean && lease.commit) {
        session.committedText = joinTranscript(session.committedText, clean);
        session.committedBytes = lease.endOffset;
        return session.committedText;
    }
    return succeeded ? joinTranscript(session.committedText, clean) : session.committedText;
}

/** Stops the active provider and materializes one canonical WAV for the final pass. */
export async function stopCapture(): Promise<string> {
    const session = activeSession;
    if (!session) throw new Error("not recording");
    activeSession = undefined;
    const operation = stopProcess(session);
    stopping = operation;
    try {
        await operation;
    } finally {
        if (stopping === operation) stopping = undefined;
    }
    emitStatus(session, true);
    const pcm = session.buffer.slice();
    if (pcm.length < DEFAULT_VOICE_AUDIO_OPTIONS.sampleRate / 5) {
        throw new Error("no audio captured");
    }
    return writeTemporaryWave(pcm, "final");
}

export async function cancelCapture(): Promise<void> {
    const session = activeSession;
    activeSession = undefined;
    if (!session) return;
    const operation = stopProcess(session);
    stopping = operation;
    try {
        await operation;
    } finally {
        if (stopping === operation) stopping = undefined;
        emitStatus(session, true);
    }
}

export function getCaptureStatus(): VoiceCaptureStatus | undefined {
    return activeSession ? statusOf(activeSession, true) : undefined;
}

async function startCandidate(
    candidate: VoiceCaptureCandidate,
    allCandidates: VoiceCaptureCandidate[],
    callbacks: VoiceCaptureCallbacks,
    captureId: string,
): Promise<CaptureSession> {
    const child = spawn(candidate.command, candidate.args, { stdio: ["pipe", "pipe", "pipe"] });
    const session: CaptureSession = {
        captureId,
        candidate,
        availableProviders: allCandidates.map((item) => item.id),
        child,
        buffer: new VoiceAudioBuffer(),
        callbacks,
        stderr: "",
        stopping: false,
        lastStatusAt: 0,
        committedBytes: 0,
        committedText: "",
        lastPreviewAt: 0,
    };

    try {
        await waitForFirstAudio(session, callbacks);
    } catch (error) {
        // Release the failed provider before the fallback opens the same device.
        await stopProcess(session);
        throw error;
    }
    return session;
}

function waitForFirstAudio(
    session: CaptureSession,
    callbacks: VoiceCaptureCallbacks,
): Promise<void> {
    const { child, captureId } = session;
    return new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(
            () => fail(new Error("no audio arrived before startup timeout")),
            CAPTURE_STARTUP_TIMEOUT_MS,
        );
        const finish = (callback: () => void) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            callback();
        };
        const fail = (error: Error) => finish(() => reject(error));
        child.stdout.on("data", (chunk: Buffer) => {
            const activity = session.buffer.append(chunk);
            if (session.buffer.metrics().capturedBytes > 0) finish(resolve);
            if (activity.speechStarted) callbacks.onSpeech?.(captureId);
            if (activity.silenceStarted) callbacks.onSilence?.(captureId);
            emitStatus(session);
        });
        child.stderr.on("data", (chunk: Buffer) => {
            session.stderr = trimError(session.stderr + chunk.toString());
        });
        child.once("error", fail);
        child.once("close", (code) => {
            if (!settled) {
                fail(
                    new Error(
                        `provider exited before delivering audio (code ${code}). ${session.stderr}`.trim(),
                    ),
                );
            } else if (!session.stopping) {
                session.lastError =
                    `Microphone provider stopped unexpectedly (code ${code}). ${session.stderr}`.trim();
                if (activeSession === session) activeSession = undefined;
                emitStatus(session, true);
            }
        });
    });
}

async function stopProcess(session: CaptureSession): Promise<void> {
    if (session.stopping) return;
    session.stopping = true;
    const child = session.child;
    if (child.exitCode !== null || child.killed) return;
    if (await signalAndWait(child, "SIGINT", 1_500)) return;
    if (await signalAndWait(child, "SIGTERM", 1_000)) return;
    child.kill("SIGKILL");
    await waitForClose(child, 1_000);
}

async function signalAndWait(
    child: ChildProcessWithoutNullStreams,
    signal: NodeJS.Signals,
    timeoutMs: number,
): Promise<boolean> {
    try {
        child.kill(signal);
    } catch {
        return true;
    }
    return waitForClose(child, timeoutMs);
}

function waitForClose(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
    if (child.exitCode !== null) return Promise.resolve(true);
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            child.off("close", closed);
            resolve(false);
        }, timeoutMs);
        const closed = () => {
            clearTimeout(timer);
            resolve(true);
        };
        child.once("close", closed);
    });
}

async function availableCandidates(ffmpegPath: string): Promise<VoiceCaptureCandidate[]> {
    let windowsDevice: string | undefined;
    if (process.platform === "win32") windowsDevice = await firstDshowAudioDevice(ffmpegPath);
    return buildVoiceCaptureCandidates(ffmpegPath, process.platform, windowsDevice).filter(
        (candidate) => executableExists(candidate.command),
    );
}

async function firstDshowAudioDevice(ffmpegPath: string): Promise<string | undefined> {
    const command = ffmpegPath.trim() || "ffmpeg";
    if (!executableExists(command)) return undefined;
    return new Promise((resolve) => {
        const child = spawn(command, [
            "-hide_banner",
            "-list_devices",
            "true",
            "-f",
            "dshow",
            "-i",
            "dummy",
        ]);
        let stderr = "";
        child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
        child.once("error", () => resolve(undefined));
        child.once("close", () => resolve(stderr.match(/"([^"]+)"\s*\(audio\)/)?.[1]));
    });
}

function statusOf(session: CaptureSession, recording: boolean): VoiceCaptureStatus {
    return {
        captureId: session.captureId,
        recording: recording && activeSession === session && !session.stopping,
        provider: session.candidate.id,
        providerLabel: session.candidate.label,
        device: session.candidate.device,
        availableProviders: session.availableProviders,
        lastError: session.lastError,
        ...session.buffer.metrics(),
    };
}

function emitStatus(session: CaptureSession, force = false): void {
    const now = Date.now();
    if (!force && now - session.lastStatusAt < STATUS_INTERVAL_MS) return;
    session.lastStatusAt = now;
    session.callbacks.onStatus?.(statusOf(session, true));
}

function writeTemporaryWave(pcm: Buffer, purpose: "preview" | "final"): string {
    const file = path.join(
        os.tmpdir(),
        `symposium-voice-${purpose}-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`,
    );
    fs.writeFileSync(file, encodePcm16Wave(pcm));
    return file;
}

function createCaptureId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function joinTranscript(left: string, right: string): string {
    return !left.trim()
        ? right.trim()
        : !right.trim()
          ? left.trim()
          : `${left.trim()} ${right.trim()}`;
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function trimError(error: string): string {
    return error.length <= 800 ? error : error.slice(-800);
}
