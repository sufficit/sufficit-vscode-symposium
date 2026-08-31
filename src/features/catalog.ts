import { ADAPTERS_FEATURE } from "../adapters/feature";
import { AI_TOOLS_FEATURE } from "../adapters/aiTools/feature";
import { CLAUDE_ADAPTER_FEATURE } from "../adapters/claude/feature";
import { CODEX_ADAPTER_FEATURE } from "../adapters/codex/feature";
import { COPILOT_ADAPTER_FEATURE } from "../adapters/copilot/feature";
import { OPENAI_ADAPTER_FEATURE } from "../adapters/openai/feature";
import { AHP_FEATURE } from "../ahp/feature";
import { CHANGESETS_FEATURE } from "../ahp/capabilities/changesets/feature";
import { CLIENT_TOOLS_FEATURE } from "../ahp/capabilities/clientTools/feature";
import { CUSTOMIZATIONS_FEATURE } from "../ahp/capabilities/customizations/feature";
import { RESOURCES_FEATURE } from "../ahp/capabilities/resources/feature";
import { TELEMETRY_FEATURE } from "../ahp/capabilities/telemetry/feature";
import { TERMINAL_FEATURE } from "../ahp/capabilities/terminal/feature";
import { API_FEATURE } from "../api/feature";
import { AUTH_FEATURE } from "../auth/feature";
import { COMPRESSION_FEATURE } from "../compression/feature";
import { CONFIGURATION_FEATURE } from "../config/feature";
import { RELAY_FEATURE } from "../net/feature";
import { PWA_FEATURE } from "../pwa/feature";
import { RECOVERY_FEATURE } from "../recovery/feature";
import { SCM_FEATURE } from "../scm/feature";
import { SESSIONS_FEATURE } from "../sessions/feature";
import { SYNC_FEATURE } from "../sync/feature";
import { CHAT_UI_FEATURE } from "../ui/feature";
import { VOICE_FEATURE } from "../voice/feature";
import type { FeatureVersionMap, SymposiumFeatureDefinition } from "./definition";

export const SYMPOSIUM_FEATURES = Object.freeze([
    CLAUDE_ADAPTER_FEATURE,
    CODEX_ADAPTER_FEATURE,
    COPILOT_ADAPTER_FEATURE,
    OPENAI_ADAPTER_FEATURE,
    ADAPTERS_FEATURE,
    AHP_FEATURE,
    AI_TOOLS_FEATURE,
    API_FEATURE,
    AUTH_FEATURE,
    CHANGESETS_FEATURE,
    CHAT_UI_FEATURE,
    CLIENT_TOOLS_FEATURE,
    COMPRESSION_FEATURE,
    CONFIGURATION_FEATURE,
    CUSTOMIZATIONS_FEATURE,
    PWA_FEATURE,
    RECOVERY_FEATURE,
    RELAY_FEATURE,
    RESOURCES_FEATURE,
    SCM_FEATURE,
    SESSIONS_FEATURE,
    SYNC_FEATURE,
    TELEMETRY_FEATURE,
    TERMINAL_FEATURE,
    VOICE_FEATURE,
] as const satisfies readonly SymposiumFeatureDefinition[]);

export type SymposiumFeatureNamespace = (typeof SYMPOSIUM_FEATURES)[number]["namespace"];

export const SYMPOSIUM_FEATURE_VERSIONS: FeatureVersionMap = Object.freeze(
    Object.fromEntries(SYMPOSIUM_FEATURES.map((feature) => [feature.namespace, feature.version])),
);
