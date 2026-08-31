import { defineFeature } from "../../features/definition";

export const CODEX_ADAPTER_FEATURE_VERSION = "1.0.0";

export const CODEX_ADAPTER_FEATURE = defineFeature({
    namespace: "symposium.adapter.codex",
    version: CODEX_ADAPTER_FEATURE_VERSION,
    description: "OpenAI Codex adapter integration.",
});
