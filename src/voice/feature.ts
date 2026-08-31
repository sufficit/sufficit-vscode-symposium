import { defineFeature } from "../features/definition";

export const VOICE_FEATURE_VERSION = "1.0.0";

export const VOICE_FEATURE = defineFeature({
    namespace: "symposium.voice",
    version: VOICE_FEATURE_VERSION,
    description: "Audio capture, transcription, and voice input lifecycle.",
});
