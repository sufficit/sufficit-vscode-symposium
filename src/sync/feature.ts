import { defineFeature } from "../features/definition";

export const SYNC_FEATURE_VERSION = "1.0.1";

export const SYNC_FEATURE = defineFeature({
    namespace: "symposium.sync",
    version: SYNC_FEATURE_VERSION,
    description: "Cross-instance settings and state synchronization.",
});
