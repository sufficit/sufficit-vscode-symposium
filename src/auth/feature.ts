import { defineFeature } from "../features/definition";

export const AUTH_FEATURE_VERSION = "1.0.0";

export const AUTH_FEATURE = defineFeature({
    namespace: "symposium.auth",
    version: AUTH_FEATURE_VERSION,
    description: "Authentication, credentials, and authorization flows.",
});
