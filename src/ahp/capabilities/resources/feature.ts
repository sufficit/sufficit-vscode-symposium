import { defineFeature } from "../../../features/definition";

export const RESOURCES_FEATURE_VERSION = "1.0.0";

export const RESOURCES_FEATURE = defineFeature({
    namespace: "symposium.resources",
    version: RESOURCES_FEATURE_VERSION,
    description: "Resource discovery and content exchange for agents.",
});
