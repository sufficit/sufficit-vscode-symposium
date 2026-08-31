import { defineFeature } from "../features/definition";

export const COMPRESSION_FEATURE_VERSION = "1.0.0";

export const COMPRESSION_FEATURE = defineFeature({
    namespace: "symposium.compression",
    version: COMPRESSION_FEATURE_VERSION,
    description: "Conversation context compression and summarization.",
});
