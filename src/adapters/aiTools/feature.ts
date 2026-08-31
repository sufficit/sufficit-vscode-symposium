import { defineFeature } from "../../features/definition";

export const AI_TOOLS_FEATURE_VERSION = "1.0.0";

export const AI_TOOLS_FEATURE = defineFeature({
    namespace: "symposium.ai-tools",
    version: AI_TOOLS_FEATURE_VERSION,
    description: "Discovery and execution of tools exposed to AI adapters.",
});
