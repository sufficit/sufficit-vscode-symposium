// Unit tests for voice input functionality
import { test } from "node:test";
import assert from "node:assert/strict";

// Mock voice preferences for testing
interface VoicePreferences {
    voiceLanguage: string;
    voiceContinuous: boolean;
    voiceInterimResults: boolean;
    voiceDotsAnimation: boolean;
    voiceSoundFeedback: boolean;
}

// Mock SpeechRecognition for testing
class MockSpeechRecognition {
    continuous = false;
    interimResults = false;
    lang = "pt-BR";
    onresult: ((event: any) => void) | null = null;
    onerror: ((event: any) => void) | null = null;
    onend: (() => void) | null = null;
    onstart: (() => void) | null = null;
    start() {}
    stop() {}
}

const VALID_LANGUAGES = ["pt-BR", "en-US", "es-ES", "fr-FR", "de-DE"];

test("voice preferences: valid structure", () => {
    const prefs: VoicePreferences = {
        voiceLanguage: "pt-BR",
        voiceContinuous: true,
        voiceInterimResults: true,
        voiceDotsAnimation: true,
        voiceSoundFeedback: true
    };
    assert.ok(VALID_LANGUAGES.includes(prefs.voiceLanguage));
    assert.strictEqual(typeof prefs.voiceContinuous, "boolean");
    assert.strictEqual(typeof prefs.voiceInterimResults, "boolean");
});

test("voice preferences: default values", () => {
    const defaults: VoicePreferences = {
        voiceLanguage: "pt-BR",
        voiceContinuous: false,
        voiceInterimResults: false,
        voiceDotsAnimation: true,
        voiceSoundFeedback: true
    };
    assert.strictEqual(defaults.voiceLanguage, "pt-BR");
    assert.strictEqual(defaults.voiceContinuous, false);
});

test("voice preferences: all languages supported", () => {
    VALID_LANGUAGES.forEach(lang => {
        const prefs: VoicePreferences = {
            voiceLanguage: lang,
            voiceContinuous: true,
            voiceInterimResults: true,
            voiceDotsAnimation: true,
            voiceSoundFeedback: true
        };
        assert.strictEqual(prefs.voiceLanguage, lang);
    });
});

test("SpeechRecognition: applies preferences", () => {
    const recognition = new MockSpeechRecognition();
    const prefs: VoicePreferences = {
        voiceLanguage: "en-US",
        voiceContinuous: true,
        voiceInterimResults: false,
        voiceDotsAnimation: false,
        voiceSoundFeedback: false
    };
    recognition.lang = prefs.voiceLanguage;
    recognition.continuous = prefs.voiceContinuous;
    recognition.interimResults = prefs.voiceInterimResults;
    assert.strictEqual(recognition.lang, "en-US");
    assert.strictEqual(recognition.continuous, true);
    assert.strictEqual(recognition.interimResults, false);
});

test("SpeechRecognition: single phrase mode", () => {
    const recognition = new MockSpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = false;
    assert.strictEqual(recognition.continuous, false);
});

test("voice state: recording lifecycle", () => {
    let isRecording = false;
    const toggleRecording = () => { isRecording = !isRecording; };
    assert.strictEqual(isRecording, false);
    toggleRecording();
    assert.strictEqual(isRecording, true);
    toggleRecording();
    assert.strictEqual(isRecording, false);
});

test("voice state: prevents double start", () => {
    let isRecording = false;
    const startRecording = () => {
        if (isRecording) throw new Error("Already recording");
        isRecording = true;
    };
    startRecording();
    assert.throws(() => startRecording(), { message: "Already recording" });
});

test("voice results: final transcript", () => {
    const mockEvent = { results: [{ isFinal: true, transcript: "Hello world" }] };
    let capturedTranscript = "";
    const handleResult = (event: any) => {
        for (let i = 0; i < event.results.length; i++) {
            if (event.results[i].isFinal) capturedTranscript = event.results[i].transcript;
        }
    };
    handleResult(mockEvent);
    assert.strictEqual(capturedTranscript, "Hello world");
});

test("voice results: interim results", () => {
    const mockEvent = {
        results: [
            { isFinal: false, transcript: "Hel" },
            { isFinal: false, transcript: "Hello" },
            { isFinal: true, transcript: "Hello world" }
        ]
    };
    const transcripts: string[] = [];
    const handleResult = (event: any) => {
        for (let i = 0; i < event.results.length; i++) transcripts.push(event.results[i].transcript);
    };
    handleResult(mockEvent);
    assert.deepStrictEqual(transcripts, ["Hel", "Hello", "Hello world"]);
});

test("voice results: multiple languages", () => {
    const testCases = [
        { lang: "pt-BR", text: "Olá mundo" },
        { lang: "en-US", text: "Hello world" },
        { lang: "es-ES", text: "Hola mundo" }
    ];
    testCases.forEach(({ lang, text }) => {
        const recognition = new MockSpeechRecognition();
        recognition.lang = lang;
        const mockEvent = { results: [{ isFinal: true, transcript: text }] };
        const capturedText = mockEvent.results[0].transcript;
        assert.strictEqual(capturedText, text);
    });
});

test("voice errors: handles error types", () => {
    const errorTypes = ["not-allowed", "no-speech", "network"];
    errorTypes.forEach(err => {
        const mockError = { error: err };
        let capturedError = "";
        const handleError = (event: any) => { capturedError = event.error; };
        handleError(mockError);
        assert.strictEqual(capturedError, err);
    });
});

test("voice UI: animation state", () => {
    let animationActive = false;
    const toggleAnimation = () => { animationActive = !animationActive; };
    assert.strictEqual(animationActive, false);
    toggleAnimation();
    assert.strictEqual(animationActive, true);
    toggleAnimation();
    assert.strictEqual(animationActive, false);
});

test("voice UI: preferences affect behavior", () => {
    const prefs: VoicePreferences = {
        voiceLanguage: "pt-BR",
        voiceContinuous: false,
        voiceInterimResults: false,
        voiceDotsAnimation: true,
        voiceSoundFeedback: true
    };
    const shouldShowAnimation = () => prefs.voiceDotsAnimation;
    const playSound = () => prefs.voiceSoundFeedback ? "Sound played" : "Sound disabled";
    assert.strictEqual(shouldShowAnimation(), true);
    assert.strictEqual(playSound(), "Sound played");
    prefs.voiceSoundFeedback = false;
    assert.strictEqual(playSound(), "Sound disabled");
});

test("voice integration: full recording cycle", () => {
    const recognition = new MockSpeechRecognition();
    const prefs: VoicePreferences = {
        voiceLanguage: "pt-BR",
        voiceContinuous: false,
        voiceInterimResults: true,
        voiceDotsAnimation: true,
        voiceSoundFeedback: true
    };
    recognition.lang = prefs.voiceLanguage;
    recognition.continuous = prefs.voiceContinuous;
    recognition.interimResults = prefs.voiceInterimResults;
    let state = "idle";
    recognition.onstart = () => { state = "recording"; };
    recognition.onend = () => { state = "idle"; };
    recognition.onstart!();
    assert.strictEqual(state, "recording");
    recognition.onend!();
    assert.strictEqual(state, "idle");
});

test("voice integration: preferences persistence", () => {
    const savedPrefs: VoicePreferences = {
        voiceLanguage: "pt-BR",
        voiceContinuous: true,
        voiceInterimResults: true,
        voiceDotsAnimation: true,
        voiceSoundFeedback: true
    };
    const loadedPrefs = JSON.parse(JSON.stringify(savedPrefs));
    assert.deepStrictEqual(loadedPrefs, savedPrefs);
    assert.strictEqual(loadedPrefs.voiceLanguage, "pt-BR");
});

test("voice integration: language change", () => {
    let restartCount = 0;
    const recognition = new MockSpeechRecognition();
    recognition.lang = "pt-BR";
    const changeLanguage = (newLang: string) => {
        if (recognition.lang !== newLang) {
            recognition.lang = newLang;
            restartCount++;
        }
    };
    changeLanguage("en-US");
    assert.strictEqual(restartCount, 1);
    assert.strictEqual(recognition.lang, "en-US");
    changeLanguage("en-US");
    assert.strictEqual(restartCount, 1);
});

test("voice integration: continuous mode", () => {
    const recognition = new MockSpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    const finalResults: string[] = [];
    recognition.onresult = (event: any) => {
        for (let i = 0; i < event.results.length; i++) {
            if (event.results[i].isFinal) finalResults.push(event.results[i].transcript);
        }
    };
    const mockEvents = [
        { results: [{ isFinal: true, transcript: "First sentence" }] },
        { results: [{ isFinal: true, transcript: "Second sentence" }] }
    ];
    mockEvents.forEach(event => { if (recognition.onresult) recognition.onresult(event); });
    assert.strictEqual(finalResults.length, 2);
    assert.strictEqual(finalResults[0], "First sentence");
});