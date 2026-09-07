import { defineFeature } from "../features/definition";

export const RELAY_FEATURE_VERSION = "1.0.0";

export const RELAY_FEATURE = defineFeature({
    namespace: "symposium.relay",
    version: RELAY_FEATURE_VERSION,
    description: "Relay networking and remote session transport.",
});
