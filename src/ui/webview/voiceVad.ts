let stream: MediaStream | null = null;
let ownsStream = false;
let audioContext: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let animationFrame: number | null = null;

const SILENCE_RMS = 0.02;
const SILENCE_MS = 900;

export async function startVadMonitor(
    onSilence: () => void,
    captureStream?: MediaStream,
): Promise<void> {
    stopVadMonitor();
    ownsStream = !captureStream;
    try {
        stream = captureStream ?? (await navigator.mediaDevices.getUserMedia({ audio: true }));
    } catch {
        return;
    }
    audioContext = new AudioContext();
    const source = audioContext.createMediaStreamSource(stream);
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    const data = new Uint8Array(analyser.fftSize);
    let silenceStartedAt = 0;
    let hadSpeech = false;
    const tick = () => {
        if (!analyser) return;
        analyser.getByteTimeDomainData(data);
        let sumSquares = 0;
        for (const sample of data) {
            const value = (sample - 128) / 128;
            sumSquares += value * value;
        }
        const rms = Math.sqrt(sumSquares / data.length);
        const now = Date.now();
        if (rms > SILENCE_RMS) {
            hadSpeech = true;
            silenceStartedAt = 0;
        } else if (hadSpeech && !silenceStartedAt) {
            silenceStartedAt = now;
        } else if (hadSpeech && now - silenceStartedAt >= SILENCE_MS) {
            silenceStartedAt = 0;
            hadSpeech = false;
            onSilence();
        }
        animationFrame = requestAnimationFrame(tick);
    };
    animationFrame = requestAnimationFrame(tick);
}

export function stopVadMonitor(): void {
    if (animationFrame) cancelAnimationFrame(animationFrame);
    animationFrame = null;
    if (ownsStream) {
        for (const track of stream?.getTracks() ?? []) track.stop();
    }
    stream = null;
    ownsStream = false;
    if (audioContext) void audioContext.close().catch(() => undefined);
    audioContext = null;
    analyser = null;
}
