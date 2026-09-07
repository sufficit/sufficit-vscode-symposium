import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string): string => readFileSync(path, "utf8");

test("host voice protocol correlates start, preview, stop and responses by capture id", () => {
    const protocol = read("src/protocol/chat.ts");
    const client = read("src/ui/webview/voiceHostSession.ts");
    const host = read("src/ui/surfaceMessageVoice.ts");

    assert.match(protocol, /type: "voice-start"; captureId: string/);
    assert.match(protocol, /type: "voice-preview"; captureId: string/);
    assert.match(protocol, /type: "voice-stop"; captureId: string/);
    assert.match(client, /return !!captureId && candidate === captureId/);
    assert.match(host, /preview\.captureId !== captureId/);
    assert.match(host, /await previewJobs\.get\(message\.captureId\)/);
    assert.match(host, /type: "voice-preview-result", captureId, text: ""/);
});

test("local capture is bounded by startup and stop deadlines and probes Opus formats", () => {
    const source = read("src/ui/webview/voiceLocalCapture.ts");

    assert.match(source, /MICROPHONE_OPEN_TIMEOUT_MS = 8_000/);
    assert.match(source, /RECORDER_STOP_TIMEOUT_MS = 1_500/);
    assert.match(source, /activeRecorder\.start\(RECORDER_TIMESLICE_MS\)/);
    assert.match(source, /audio\/webm;codecs=opus/);
    assert.match(source, /audio\/ogg;codecs=opus/);
    assert.match(source, /readAsDataURL\(blob\)/);
    assert.doesNotMatch(source, /String\.fromCharCode/);
});

test("continuous local dictation reuses the recorder stream for VAD", () => {
    const lifecycle = read("src/ui/webview/voiceLocalLifecycle.ts");
    const vad = read("src/ui/webview/voiceVad.ts");

    assert.match(lifecycle, /startVadMonitor\(options\.onSilence, stream\)/);
    assert.match(vad, /captureStream \?\?/);
    assert.match(vad, /ownsStream = !captureStream/);
});

test("voice UI exposes live state and microphone level without animation dependency", () => {
    const html = read("src/ui/chatHtml.ts");
    const ui = read("src/ui/webview/voiceUi.ts");
    const css = read("src/ui/webview/chat.css");

    assert.match(html, /id="voiceActivity" role="status" aria-live="polite"/);
    assert.match(ui, /setAttribute\("role", "meter"\)/);
    assert.match(ui, /Opening microphone…/);
    assert.match(ui, /Finalizing transcription…/);
    assert.match(css, /prefers-reduced-motion: reduce/);
});
