import { defineFeature } from "../../../features/definition";

export const CHANGESETS_FEATURE_VERSION = "1.0.0";

export const CHANGESETS_FEATURE = defineFeature({
    namespace: "symposium.changesets",
    version: CHANGESETS_FEATURE_VERSION,
    description: "Structured workspace change sets produced by agents.",
});
