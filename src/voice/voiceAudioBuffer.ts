export interface VoiceAudioBufferOptions {
    sampleRate: number;
    channels: number;
    bitsPerSample: number;
    maximumSeconds: number;
    silenceMilliseconds: number;
    speechThresholdDbFs: number;
}

export interface VoiceAudioActivity {
    speechStarted: boolean;
    silenceStarted: boolean;
}

export interface VoiceAudioMetrics {
    capturedBytes: number;
    durationMilliseconds: number;
    rmsDbFs: number;
    peakDbFs: number;
    hasSpeech: boolean;
    isSilent: boolean;
    truncated: boolean;
}

export const DEFAULT_VOICE_AUDIO_OPTIONS: VoiceAudioBufferOptions = {
    sampleRate: 16_000,
    channels: 1,
    bitsPerSample: 16,
    maximumSeconds: 300,
    silenceMilliseconds: 450,
    speechThresholdDbFs: -42,
};

/** Bounded PCM16 storage plus low-cost signal and voice-activity telemetry. */
export class VoiceAudioBuffer {
    private readonly chunks: Buffer[] = [];
    private readonly maximumBytes: number;
    private readonly speechThreshold: number;
    private length = 0;
    private peak = 0;
    private currentRms = 0;
    private hasSpeech = false;
    private isSilent = false;
    private truncated = false;
    private lastSpeechAt = 0;
    private pendingByte: number | undefined;

    constructor(private readonly options = DEFAULT_VOICE_AUDIO_OPTIONS) {
        this.maximumBytes =
            options.sampleRate *
            options.channels *
            (options.bitsPerSample / 8) *
            options.maximumSeconds;
        this.speechThreshold = Math.pow(10, options.speechThresholdDbFs / 20) * 0x7fff;
    }

    append(input: Buffer, now = Date.now()): VoiceAudioActivity {
        const normalized = this.normalizeSamples(input);
        const remaining = this.maximumBytes - this.length;
        const acceptedLength = Math.max(0, Math.min(remaining, normalized.length)) & ~1;
        const accepted = normalized.subarray(0, acceptedLength);
        if (acceptedLength < normalized.length) this.truncated = true;
        if (accepted.length) {
            const copy = Buffer.from(accepted);
            this.chunks.push(copy);
            this.length += copy.length;
        }

        const rms = analyzePcm16(accepted);
        this.currentRms = rms.rms;
        this.peak = Math.max(this.peak, rms.peak);

        let speechStarted = false;
        let silenceStarted = false;
        if (rms.rms >= this.speechThreshold) {
            speechStarted = !this.hasSpeech || this.isSilent;
            this.hasSpeech = true;
            this.isSilent = false;
            this.lastSpeechAt = now;
        } else if (
            this.hasSpeech &&
            !this.isSilent &&
            now - this.lastSpeechAt >= this.options.silenceMilliseconds
        ) {
            this.isSilent = true;
            silenceStarted = true;
        }
        return { speechStarted, silenceStarted };
    }

    metrics(): VoiceAudioMetrics {
        const bytesPerSecond =
            this.options.sampleRate * this.options.channels * (this.options.bitsPerSample / 8);
        return {
            capturedBytes: this.length,
            durationMilliseconds: (this.length / bytesPerSecond) * 1000,
            rmsDbFs: toDbFs(this.currentRms),
            peakDbFs: toDbFs(this.peak),
            hasSpeech: this.hasSpeech,
            isSilent: this.isSilent,
            truncated: this.truncated,
        };
    }

    slice(start = 0, end = this.length): Buffer {
        const boundedStart = Math.max(0, Math.min(start, this.length));
        const boundedEnd = Math.max(boundedStart, Math.min(end, this.length));
        const result = Buffer.allocUnsafe(boundedEnd - boundedStart);
        let sourceOffset = 0;
        let targetOffset = 0;
        for (const chunk of this.chunks) {
            const chunkEnd = sourceOffset + chunk.length;
            const overlapStart = Math.max(sourceOffset, boundedStart);
            const overlapEnd = Math.min(chunkEnd, boundedEnd);
            if (overlapEnd > overlapStart) {
                const copied = overlapEnd - overlapStart;
                chunk.copy(
                    result,
                    targetOffset,
                    overlapStart - sourceOffset,
                    overlapEnd - sourceOffset,
                );
                targetOffset += copied;
            }
            sourceOffset = chunkEnd;
            if (sourceOffset >= boundedEnd) break;
        }
        return result;
    }

    private normalizeSamples(input: Buffer): Buffer {
        if (this.pendingByte === undefined) {
            if (input.length % 2 === 0) return input;
            this.pendingByte = input[input.length - 1];
            return input.subarray(0, input.length - 1);
        }
        if (!input.length) return Buffer.alloc(0);
        const joined = Buffer.allocUnsafe(input.length + 1);
        joined[0] = this.pendingByte;
        input.copy(joined, 1);
        this.pendingByte = undefined;
        if (joined.length % 2 === 0) return joined;
        this.pendingByte = joined[joined.length - 1];
        return joined.subarray(0, joined.length - 1);
    }
}

export function encodePcm16Wave(
    pcm: Buffer,
    sampleRate = DEFAULT_VOICE_AUDIO_OPTIONS.sampleRate,
    channels = DEFAULT_VOICE_AUDIO_OPTIONS.channels,
): Buffer {
    const header = Buffer.alloc(44);
    const bitsPerSample = 16;
    const byteRate = sampleRate * channels * (bitsPerSample / 8);
    header.write("RIFF", 0, "ascii");
    header.writeUInt32LE(36 + pcm.length, 4);
    header.write("WAVE", 8, "ascii");
    header.write("fmt ", 12, "ascii");
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(channels * (bitsPerSample / 8), 32);
    header.writeUInt16LE(bitsPerSample, 34);
    header.write("data", 36, "ascii");
    header.writeUInt32LE(pcm.length, 40);
    return Buffer.concat([header, pcm]);
}

function analyzePcm16(pcm: Buffer): { rms: number; peak: number } {
    let squares = 0;
    let peak = 0;
    const samples = Math.floor(pcm.length / 2);
    for (let offset = 0; offset + 1 < pcm.length; offset += 2) {
        const sample = pcm.readInt16LE(offset);
        const magnitude = Math.abs(sample);
        peak = Math.max(peak, magnitude);
        squares += sample * sample;
    }
    return { rms: samples ? Math.sqrt(squares / samples) : 0, peak };
}

function toDbFs(amplitude: number): number {
    if (amplitude <= 0) return -96;
    return Math.max(-96, 20 * Math.log10(amplitude / 0x7fff));
}
