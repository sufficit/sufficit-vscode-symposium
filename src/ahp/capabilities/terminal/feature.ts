import { defineFeature } from "../../../features/definition";

export const TERMINAL_FEATURE_VERSION = "1.0.0";

export const TERMINAL_FEATURE = defineFeature({
    namespace: "symposium.terminal",
    version: TERMINAL_FEATURE_VERSION,
    description: "Terminal command execution and streamed output.",
});
