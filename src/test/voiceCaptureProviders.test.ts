import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildVoiceCaptureCandidates, executableExists } from "../voice/voiceCaptureProviders";

test("Linux capture prefers PipeWire, then PulseAudio, then ALSA", () => {
    const candidates = buildVoiceCaptureCandidates("/opt/ffmpeg", "linux");

    assert.deepEqual(
        candidates.map((candidate) => candidate.id),
        ["linux-pipewire", "linux-pulse", "linux-alsa"],
    );
    assert.deepEqual(candidates[0].args.slice(0, 2), ["--raw", "--format"]);
    assert.equal(candidates[1].command, "/opt/ffmpeg");
    assert.ok(candidates[1].args.includes("s16le"));
    assert.ok(candidates[2].args.includes("S16_LE"));
});

test("platform capture candidates always emit mono 16 kHz PCM", () => {
    const candidates = [
        ...buildVoiceCaptureCandidates("ffmpeg", "darwin"),
        ...buildVoiceCaptureCandidates("ffmpeg", "win32", "Microphone"),
    ];

    assert.equal(candidates.length, 2);
    for (const candidate of candidates) {
        assert.ok(candidate.args.includes("16000"));
        assert.ok(candidate.args.includes("1"));
        assert.ok(candidate.args.includes("s16le"));
        assert.equal(candidate.args.at(-1), "pipe:1");
    }
});

test("Windows capture is not advertised without a discovered input device", () => {
    assert.deepEqual(buildVoiceCaptureCandidates("ffmpeg", "win32"), []);
});

test("executable discovery supports absolute paths and PATH entries", (t) => {
    const directory = mkdtempSync(join(tmpdir(), "symposium-voice-provider-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const executable = join(directory, "voice-provider");
    writeFileSync(executable, "test");

    assert.equal(executableExists(executable), true);
    assert.equal(executableExists("voice-provider", directory), true);
    assert.equal(executableExists("missing-provider", directory), false);
});
