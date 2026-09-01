import { defineFeature } from "../features/definition";

export const CHAT_UI_FEATURE_VERSION = "1.1.0";

export const CHAT_UI_FEATURE = defineFeature({
    namespace: "symposium.chat-ui",
    version: CHAT_UI_FEATURE_VERSION,
    description: "Interactive chat, session list, and message presentation.",
});
