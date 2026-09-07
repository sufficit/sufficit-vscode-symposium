import { defineFeature } from "../../features/definition";

export const CLAUDE_ADAPTER_FEATURE_VERSION = "1.1.0";

export const CLAUDE_ADAPTER_FEATURE = defineFeature({
    namespace: "symposium.adapter.claude",
    version: CLAUDE_ADAPTER_FEATURE_VERSION,
    description: "Claude Code adapter integration.",
});
