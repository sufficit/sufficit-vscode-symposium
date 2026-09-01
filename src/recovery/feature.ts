import { defineFeature } from "../features/definition";

export const RECOVERY_FEATURE_VERSION = "1.1.0";

export const RECOVERY_FEATURE = defineFeature({
    namespace: "symposium.recovery",
    version: RECOVERY_FEATURE_VERSION,
    description: "Visible bounded recovery from transient provider and transport failures.",
});
