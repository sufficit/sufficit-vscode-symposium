import { defineFeature } from "../features/definition";

export const PWA_FEATURE_VERSION = "1.0.0";

export const PWA_FEATURE = defineFeature({
    namespace: "symposium.pwa",
    version: PWA_FEATURE_VERSION,
    description: "Progressive web application assets and lifecycle.",
});
