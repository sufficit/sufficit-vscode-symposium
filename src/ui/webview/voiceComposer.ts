import { input } from "./dom";
import { resizeInput } from "./inputSizing";
import { markComposerSpeechInput } from "./composerBridge";
import { setStatus } from "./status";

export function setVoiceInputValue(value: string): void {
    if (input.value === value) return;
    input.value = value;
    markComposerSpeechInput(true);
    resizeInput();
    setStatus();
}

export function dispatchVoiceEnded(): void {
    window.dispatchEvent(new Event("symposium-voice-ended"));
}
