import { defineFeature } from "../features/definition";

export const API_FEATURE_VERSION = "1.0.0";

export const API_FEATURE = defineFeature({
    namespace: "symposium.api",
    version: API_FEATURE_VERSION,
    description: "Public programmatic API and discovery documents.",
});
