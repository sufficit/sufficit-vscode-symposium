import { defineFeature } from "../../../features/definition";

export const TELEMETRY_FEATURE_VERSION = "1.0.0";

export const TELEMETRY_FEATURE = defineFeature({
    namespace: "symposium.telemetry",
    version: TELEMETRY_FEATURE_VERSION,
    description: "Usage, timing, and diagnostic telemetry exchange.",
});
