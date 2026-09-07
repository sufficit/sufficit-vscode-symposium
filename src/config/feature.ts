import { defineFeature } from "../features/definition";

export const CONFIGURATION_FEATURE_VERSION = "1.1.0";

export const CONFIGURATION_FEATURE = defineFeature({
    namespace: "symposium.configuration",
    version: CONFIGURATION_FEATURE_VERSION,
    description: "Settings, presets, and runtime configuration resolution.",
});
