import { defineFeature } from "../../../features/definition";

export const CLIENT_TOOLS_FEATURE_VERSION = "1.0.0";

export const CLIENT_TOOLS_FEATURE = defineFeature({
    namespace: "symposium.client-tools",
    version: CLIENT_TOOLS_FEATURE_VERSION,
    description: "Tools supplied by the Symposium client to an agent.",
});
