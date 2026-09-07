import { defineFeature } from "../features/definition";

export const ADAPTERS_FEATURE_VERSION = "1.0.0";

export const ADAPTERS_FEATURE = defineFeature({
    namespace: "symposium.adapters",
    version: ADAPTERS_FEATURE_VERSION,
    description: "Shared contract for agent adapters and their lifecycle.",
});
