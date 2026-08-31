import { defineFeature } from "../../features/definition";

export const OPENAI_ADAPTER_FEATURE_VERSION = "1.0.0";

export const OPENAI_ADAPTER_FEATURE = defineFeature({
    namespace: "symposium.adapter.openai-compatible",
    version: OPENAI_ADAPTER_FEATURE_VERSION,
    description: "OpenAI-compatible and Sufficit AI adapter integration.",
});
