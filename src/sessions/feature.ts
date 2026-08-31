import { defineFeature } from "../features/definition";

export const SESSIONS_FEATURE_VERSION = "1.0.0";

export const SESSIONS_FEATURE = defineFeature({
    namespace: "symposium.sessions",
    version: SESSIONS_FEATURE_VERSION,
    description: "Conversation sessions, history, queue, and persistence.",
});
