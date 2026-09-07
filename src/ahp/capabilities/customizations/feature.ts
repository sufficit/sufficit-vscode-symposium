import { defineFeature } from "../../../features/definition";

export const CUSTOMIZATIONS_FEATURE_VERSION = "1.0.0";

export const CUSTOMIZATIONS_FEATURE = defineFeature({
    namespace: "symposium.customizations",
    version: CUSTOMIZATIONS_FEATURE_VERSION,
    description: "Agent customization and instruction exchange.",
});
