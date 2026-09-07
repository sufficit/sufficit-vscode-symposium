import { defineFeature } from "../features/definition";

export const SCM_FEATURE_VERSION = "1.0.0";

export const SCM_FEATURE = defineFeature({
    namespace: "symposium.scm",
    version: SCM_FEATURE_VERSION,
    description: "Source control status and change integration.",
});
