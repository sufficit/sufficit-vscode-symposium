import { defineFeature } from "../features/definition";

export const AHP_FEATURE_VERSION = "0.6.2";

export const AHP_FEATURE = defineFeature({
    namespace: "symposium.ahp",
    version: AHP_FEATURE_VERSION,
    description: "Agent Host Protocol transport, events, and negotiation.",
});
