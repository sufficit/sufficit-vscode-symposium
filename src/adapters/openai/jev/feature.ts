import { defineFeature } from "../../../features/definition";

export const JEV_FEATURE_VERSION = "1.0.0";

export const JEV_FEATURE = defineFeature({
    namespace: "symposium.jev",
    version: JEV_FEATURE_VERSION,
    description: "Jev tool-pair context pruning over the Sufficit AI scoring endpoint.",
});
