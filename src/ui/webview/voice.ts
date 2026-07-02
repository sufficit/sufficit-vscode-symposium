// Voice input: Web Speech API + host/local capture paths. Listeners run on import.
// Extracted from composer.ts; composer imports this module so registration fires on load.
import { vscode } from "./vscode";
import { input, micBtn } from "./dom";
import { setStatus } from "./status";
import { showToast } from "./menus";

// Voice input using Web Speech API (SpeechRecognition)
let recognition: any = null;
let isRecording = false;
let recordingDotsInterval: any = null;
let recordingTextBase = '';

// Audio feedback functions (mimicking VSCode chat sounds)
function playStartSound() {
    const audioCtx = new (window as any).AudioContext();
    const oscillator = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();
    
    oscillator.connect(gainNode);
    gainNode.connect(audioCtx.destination);
    
    oscillator.frequency.setValueAtTime(800, audioCtx.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(1200, audioCtx.currentTime + 0.1);
    gainNode.gain.setValueAtTime(0.1, audioCtx.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.15);
    
    oscillator.start(audioCtx.currentTime);
    oscillator.stop(audioCtx.currentTime + 0.15);
}

function playStopSound() {
    const audioCtx = new (window as any).AudioContext();
    const oscillator = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();
    
    oscillator.connect(gainNode);
    gainNode.connect(audioCtx.destination);
    
    oscillator.frequency.setValueAtTime(1200, audioCtx.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(600, audioCtx.currentTime + 0.1);
    gainNode.gain.setValueAtTime(0.1, audioCtx.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.15);
    
    oscillator.start(audioCtx.currentTime);
    oscillator.stop(audioCtx.currentTime + 0.15);
}

// Update recording dots animation
function updateRecordingDots() {
    const dots = ['', '.', '..', '...', '..', '.'];
    let index = 0;
    
    recordingDotsInterval = setInterval(() => {
        index = (index + 1) % dots.length;
        input.value = recordingTextBase + dots[index];
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 180) + "px";
        setStatus();
    }, 400);
}

// Voice preferences (default values, updated from host)
let voicePreferences = {
    language: 'pt-BR',
    continuous: true,
    interimResults: true,
    dotsAnimation: true,
    soundFeedback: true,
    // engine: which STT engine the host is configured for ("auto" | "webspeech" | local engines).
    engine: 'auto',
    // localStt: host can transcribe captured audio locally (whisper.cpp/faster-whisper/vosk).
    localStt: true,
    // hostCapture: host records the mic natively (ffmpeg) — preferred over
    // webview getUserMedia, whose permission VS Code keeps dropping.
    hostCapture: false,
};

// Get voice preferences from host or use defaults
function getVoicePreferences() {
    const prefs = (window as any).voicePreferences;
    if (prefs) {
        voicePreferences = {
            language: prefs.language || 'pt-BR',
            continuous: prefs.continuous !== false,
            interimResults: prefs.interimResults !== false,
            dotsAnimation: prefs.dotsAnimation !== false,
            soundFeedback: prefs.soundFeedback !== false,
            engine: prefs.engine || 'auto',
            localStt: prefs.localStt !== false,
            hostCapture: prefs.hostCapture === true,
        };
    }
    return voicePreferences;
}

function applyRecognitionPreferences() {
    if (!recognition) { return; }
    const prefs = getVoicePreferences();
    recognition.lang = prefs.language;
    recognition.continuous = prefs.continuous;
    recognition.interimResults = prefs.interimResults;
}

// Listen for voice preference updates
window.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'setVoicePreferences') {
        getVoicePreferences();
        applyRecognitionPreferences();
        updateMicVisibility();
    }
});

// Hybrid voice input.
//
// Two paths share the one mic button:
//  1. Web Speech API — runs on Google's cloud engine, only present in real
//     Chrome/Chromium (code-server in a browser). Preferred when available.
//  2. Local capture — getUserMedia + MediaRecorder grabs audio in the webview
//     and ships it to the extension host, which transcribes offline with the
//     configured engine (whisper.cpp / faster-whisper / vosk). This is the
//     desktop/Electron path where Web Speech is absent.
//
// The host tells us via voicePreferences whether local transcription is
// available (localStt) and which engine is selected (engine).
const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
const webSpeechSupported = !!SpeechRecognition;

let mediaRecorder: any = null;
let mediaStream: any = null;
let audioChunks: Blob[] = [];

// Whether the mic button should be visible at all, given current prefs.
function updateMicVisibility() {
    if (!micBtn) { return; }
    const prefs = getVoicePreferences();
    const canWebSpeech = webSpeechSupported && (prefs.engine === 'webspeech' || (prefs.engine === 'auto' && !prefs.localStt));
    const canLocal = prefs.localStt && prefs.engine !== 'webspeech';
    micBtn.style.display = (canWebSpeech || canLocal) ? 'inline-flex' : 'none';
}

// Decide which path a click should use.
//
// Explicit `webspeech` keeps the browser recognizer. In `auto`, prefer the
// host/local STT path when available so the Electron desktop build does not get
// stuck on partial Web Speech support.
function chooseVoicePath(): 'webspeech' | 'local' | 'none' {
    const prefs = getVoicePreferences();
    if (prefs.localStt && prefs.engine !== 'webspeech') { return 'local'; }
    if (webSpeechSupported && (prefs.engine === 'webspeech' || prefs.engine === 'auto')) { return 'webspeech'; }
    return 'none';
}

if (SpeechRecognition) {
    recognition = new SpeechRecognition();
    applyRecognitionPreferences();
    const prefs = getVoicePreferences();

    recognition.onstart = () => {
        isRecording = true;
        micBtn.classList.add('recording');
        setStatus('Listening...');
        if (prefs.soundFeedback) playStartSound();
        recordingTextBase = input.value;
        if (prefs.dotsAnimation) updateRecordingDots();
    };

    recognition.onend = () => {
        isRecording = false;
        micBtn.classList.remove('recording');
        setStatus('Ready');
        if (recordingDotsInterval) {
            clearInterval(recordingDotsInterval);
            recordingDotsInterval = null;
        }
    };

    recognition.onresult = (event: any) => {
        let interimTranscript = '';
        let finalTranscript = '';

        for (let i = event.resultIndex; i < event.results.length; ++i) {
            if (event.results[i].isFinal) {
                finalTranscript += event.results[i][0].transcript + ' ';
            } else {
                interimTranscript += event.results[i][0].transcript;
            }
        }

        if (finalTranscript) {
            // Update base text when we get final results
            recordingTextBase = recordingTextBase + finalTranscript;
            const dots = ['', '.', '..', '...', '..', '.'];
            const index = Math.floor(Date.now() / 400) % dots.length;
            input.value = recordingTextBase + dots[index];
            input.style.height = 'auto';
            input.style.height = Math.min(input.scrollHeight, 180) + "px";
            setStatus('Listening...');
        } else if (interimTranscript) {
            // Show interim results with dots animation
            const dots = ['', '.', '..', '...', '..', '.'];
            const index = Math.floor(Date.now() / 400) % dots.length;
            input.value = recordingTextBase + interimTranscript + dots[index];
            input.style.height = 'auto';
            input.style.height = Math.min(input.scrollHeight, 180) + "px";
            setStatus('Listening...');
        }
    };

    recognition.onerror = (event: any) => {
        isRecording = false;
        micBtn.classList.remove('recording');
        setStatus('Error: ' + event.error);
        if (recordingDotsInterval) {
            clearInterval(recordingDotsInterval);
            recordingDotsInterval = null;
        }
        if (prefs.soundFeedback) playStopSound();
        console.error('Speech recognition error:', event.error);
    };
}

// --- Native capture path (host records via ffmpeg; no webview permission) ---

let hostRecording = false;

function startHostCapture() {
    const prefs = getVoicePreferences();
    vscode.postMessage({ type: 'voice-start' });
    hostRecording = true;
    isRecording = true;
    micBtn.classList.add('recording');
    setStatus('Listening...');
    if (prefs.soundFeedback) playStartSound();
    recordingTextBase = input.value;
    if (prefs.dotsAnimation) updateRecordingDots();
}

function stopHostCapture() {
    const prefs = getVoicePreferences();
    if (prefs.soundFeedback) playStopSound();
    isRecording = false;
    hostRecording = false;
    micBtn.classList.remove('recording');
    if (recordingDotsInterval) { clearInterval(recordingDotsInterval); recordingDotsInterval = null; }
    input.value = recordingTextBase;   // drop the dots animation text
    setStatus('Transcribing...');
    vscode.postMessage({ type: 'voice-stop' });
}

// --- Local capture path (MediaRecorder → host transcription) ---

async function startLocalCapture() {
    const prefs = getVoicePreferences();
    try {
        mediaStream = await (navigator as any).mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
        showToast('Microphone unavailable: ' + ((err as Error).message || err));
        return;
    }
    audioChunks = [];
    try {
        mediaRecorder = new (window as any).MediaRecorder(mediaStream);
    } catch (err) {
        showToast('Recording not supported here: ' + ((err as Error).message || err));
        stopMediaStream();
        return;
    }
    mediaRecorder.ondataavailable = (e: any) => { if (e.data && e.data.size > 0) audioChunks.push(e.data); };
    mediaRecorder.onstop = async () => {
        const blob = new Blob(audioChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
        stopMediaStream();
        if (!blob.size) { setStatus('Ready'); return; }
        setStatus('Transcribing...');
        const buf = await blob.arrayBuffer();
        let binary = '';
        const bytes = new Uint8Array(buf);
        for (let i = 0; i < bytes.length; i++) { binary += String.fromCharCode(bytes[i]); }
        const base64 = btoa(binary);
        vscode.postMessage({ type: 'stt-transcribe', data: base64, mime: blob.type });
    };
    mediaRecorder.start();
    isRecording = true;
    micBtn.classList.add('recording');
    setStatus('Listening...');
    if (prefs.soundFeedback) playStartSound();
    recordingTextBase = input.value;
    if (prefs.dotsAnimation) updateRecordingDots();
}

function stopLocalCapture() {
    const prefs = getVoicePreferences();
    if (prefs.soundFeedback) playStopSound();
    isRecording = false;
    micBtn.classList.remove('recording');
    if (recordingDotsInterval) { clearInterval(recordingDotsInterval); recordingDotsInterval = null; }
    try { if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop(); } catch { /* ignore */ }
}

function stopMediaStream() {
    try { if (mediaStream) { for (const t of mediaStream.getTracks()) t.stop(); } } catch { /* ignore */ }
    mediaStream = null;
}

// Host returns the transcript (or an error) for the local path.
window.addEventListener('message', (e) => {
    if (!e.data) { return; }
    if (e.data.type === 'stt-result') {
        const text = (e.data.text || '').trim();
        if (recordingDotsInterval) { clearInterval(recordingDotsInterval); recordingDotsInterval = null; }
        input.value = (recordingTextBase ? recordingTextBase.replace(/[.\s]*$/, ' ') : '') + text;
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 180) + "px";
        input.focus();
        setStatus('Ready');
    } else if (e.data.type === 'stt-error') {
        if (recordingDotsInterval) { clearInterval(recordingDotsInterval); recordingDotsInterval = null; }
        if (recordingTextBase) { input.value = recordingTextBase; }
        setStatus('Ready');
        showToast('Transcription failed: ' + (e.data.error || 'unknown error'));
    } else if (e.data.type === 'voice-recording') {
        // Host couldn't open the native mic → reset the UI and fall back to
        // the webview MediaRecorder path (may still hit the permission bug).
        if (!e.data.ok && hostRecording) {
            hostRecording = false;
            isRecording = false;
            micBtn.classList.remove('recording');
            if (recordingDotsInterval) { clearInterval(recordingDotsInterval); recordingDotsInterval = null; }
            input.value = recordingTextBase;
            showToast('Native mic capture failed (' + (e.data.error || 'unknown') + ') — falling back to webview mic');
            void startLocalCapture();
        }
    }
});

// Unified mic button: route to whichever path is currently usable.
if (micBtn) {
    micBtn.addEventListener('click', () => {
        const prefs = getVoicePreferences();
        const path = chooseVoicePath();
        if (path === 'none') { showToast('Voice input is not available with the current configuration.'); return; }
        if (path === 'webspeech') {
            if (!recognition) { showToast('Speech recognition not supported in this browser'); return; }
            recognition.lang = prefs.language;
            recognition.continuous = prefs.continuous;
            recognition.interimResults = prefs.interimResults;
            if (isRecording) { if (prefs.soundFeedback) playStopSound(); recognition.stop(); }
            else { recognition.start(); }
            return;
        }
        // local path: prefer native host capture, webview MediaRecorder as fallback
        if (isRecording) {
            if (hostRecording) { stopHostCapture(); } else { stopLocalCapture(); }
        } else if (prefs.hostCapture) {
            startHostCapture();
        } else {
            void startLocalCapture();
        }
    });
}

updateMicVisibility();
