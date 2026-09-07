import * as fs from "fs";
import * as path from "path";

export type VoiceCaptureProviderId =
    | "windows-dshow"
    | "macos-avfoundation"
    | "linux-pipewire"
    | "linux-pulse"
    | "linux-alsa";

export interface VoiceCaptureCandidate {
    id: VoiceCaptureProviderId;
    label: string;
    command: string;
    args: string[];
    device: string;
}

export function buildVoiceCaptureCandidates(
    ffmpegPath: string,
    platform: NodeJS.Platform = process.platform,
    windowsDevice?: string,
): VoiceCaptureCandidate[] {
    const ffmpeg = ffmpegPath.trim() || "ffmpeg";
    if (platform === "linux") {
        return [
            {
                id: "linux-pipewire",
                label: "Linux PipeWire",
                command: "pw-record",
                args: ["--raw", "--format", "s16", "--rate", "16000", "--channels", "1", "-"],
                device: "default",
            },
            {
                id: "linux-pulse",
                label: "Linux PulseAudio (FFmpeg)",
                command: ffmpeg,
                args: [
                    "-nostdin",
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-f",
                    "pulse",
                    "-i",
                    "default",
                    "-ar",
                    "16000",
                    "-ac",
                    "1",
                    "-f",
                    "s16le",
                    "pipe:1",
                ],
                device: "default",
            },
            {
                id: "linux-alsa",
                label: "Linux ALSA",
                command: "arecord",
                args: ["-q", "-f", "S16_LE", "-r", "16000", "-c", "1", "-t", "raw", "-"],
                device: "default",
            },
        ];
    }
    if (platform === "darwin") {
        return [
            {
                id: "macos-avfoundation",
                label: "macOS AVFoundation",
                command: ffmpeg,
                args: [
                    "-nostdin",
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-f",
                    "avfoundation",
                    "-i",
                    ":0",
                    "-ar",
                    "16000",
                    "-ac",
                    "1",
                    "-f",
                    "s16le",
                    "pipe:1",
                ],
                device: "default",
            },
        ];
    }
    if (platform === "win32" && windowsDevice) {
        return [
            {
                id: "windows-dshow",
                label: "Windows DirectShow",
                command: ffmpeg,
                args: [
                    "-nostdin",
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-f",
                    "dshow",
                    "-i",
                    `audio=${windowsDevice}`,
                    "-ar",
                    "16000",
                    "-ac",
                    "1",
                    "-f",
                    "s16le",
                    "pipe:1",
                ],
                device: windowsDevice,
            },
        ];
    }
    return [];
}

export function executableExists(command: string, envPath = process.env.PATH ?? ""): boolean {
    if (path.isAbsolute(command)) return fs.existsSync(command);
    return envPath
        .split(path.delimiter)
        .filter(Boolean)
        .some((directory) => fs.existsSync(path.join(directory, command)));
}
