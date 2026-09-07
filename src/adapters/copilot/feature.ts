import { defineFeature } from "../../features/definition";

export const COPILOT_ADAPTER_FEATURE_VERSION = "1.0.0";

export const COPILOT_ADAPTER_FEATURE = defineFeature({
    namespace: "symposium.adapter.copilot",
    version: COPILOT_ADAPTER_FEATURE_VERSION,
    description: "GitHub Copilot adapter integration.",
});
