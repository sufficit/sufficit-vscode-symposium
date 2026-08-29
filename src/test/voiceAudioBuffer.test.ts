import assert from "node:assert/strict";
import test from "node:test";
import {
    encodePcm16Wave,
    VoiceAudioBuffer,
    type VoiceAudioBufferOptions,
} from "../voice/voiceAudioBuffer";

const options: VoiceAudioBufferOptions = {
    sampleRate: 100,
    channels: 1,
    bitsPerSample: 16,
    maximumSeconds: 1,
    silenceMilliseconds: 100,
    speechThresholdDbFs: -30,
};

function pcm16(...samples: number[]): Buffer {
    const result = Buffer.alloc(samples.length * 2);
    samples.forEach((sample, index) => result.writeInt16LE(sample, index * 2));
    return result;
}

test("voice audio buffer preserves PCM samples split across odd chunks", () => {
    const audio = new VoiceAudioBuffer(options);
    const original = pcm16(1_000, -2_000, 3_000);
    audio.append(original.subarray(0, 3));
    audio.append(original.subarray(3, 5));
    audio.append(original.subarray(5));

    assert.deepEqual(audio.slice(), original);
    assert.equal(audio.metrics().capturedBytes, original.length);
    assert.deepEqual(audio.slice(2, 6), original.subarray(2, 6));
});

test("voice audio buffer is bounded and reports truncation", () => {
    const audio = new VoiceAudioBuffer(options);
    audio.append(pcm16(...Array.from({ length: 150 }, () => 2_000)));

    assert.equal(audio.metrics().capturedBytes, 200);
    assert.equal(audio.metrics().durationMilliseconds, 1_000);
    assert.equal(audio.metrics().truncated, true);
});

test("voice audio buffer emits speech and silence transitions from real PCM", () => {
    const audio = new VoiceAudioBuffer(options);
    assert.deepEqual(audio.append(pcm16(12_000, -12_000), 1_000), {
        speechStarted: true,
        silenceStarted: false,
    });
    assert.deepEqual(audio.append(pcm16(0, 0), 1_050), {
        speechStarted: false,
        silenceStarted: false,
    });
    assert.deepEqual(audio.append(pcm16(0, 0), 1_101), {
        speechStarted: false,
        silenceStarted: true,
    });
    assert.equal(audio.metrics().hasSpeech, true);
    assert.equal(audio.metrics().isSilent, true);
    assert.ok(audio.metrics().peakDbFs > -10);
});

test("canonical PCM WAV has a valid header and exact payload", () => {
    const pcm = pcm16(100, -100, 2_000);
    const wav = encodePcm16Wave(pcm, 16_000, 1);

    assert.equal(wav.subarray(0, 4).toString("ascii"), "RIFF");
    assert.equal(wav.subarray(8, 12).toString("ascii"), "WAVE");
    assert.equal(wav.readUInt32LE(24), 16_000);
    assert.equal(wav.readUInt16LE(22), 1);
    assert.equal(wav.readUInt32LE(40), pcm.length);
    assert.deepEqual(wav.subarray(44), pcm);
});
