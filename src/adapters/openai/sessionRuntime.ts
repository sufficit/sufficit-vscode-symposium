import * as path from "path";
import { contextWindowFor } from "../parse";
import type { SessionStartOptions } from "../types";
import type { ShellExecutionMode } from "../aiTools/types";
import { discoverModels as discoverModelsFromCatalog } from "./discovery";
import { buildHeaders, resolveAuthToken } from "./httpAuth";
import { getDiscoveredContext, getDiscoveredLabels, getDiscoveredModels } from "./models";
import type { RequestEstimate } from "./requestWindow";
import type { ChatMessage, OpenAIAdapterConfig } from "./types";

/** Gateway-specific model, authentication, and request-context services. */
export class OpenAISessionRuntime {
    constructor(
        private readonly cfg: OpenAIAdapterConfig,
        private readonly options: SessionStartOptions,
        private readonly backend: string,
    ) {}

    model(): string {
        return (
            this.options.model ||
            this.cfg.model ||
            this.cfg.models[0] ||
            getDiscoveredModels(this.cfg.baseUrl)?.[0] ||
            ""
        );
    }

    label(id: string): string {
        return id ? (getDiscoveredLabels(this.cfg.baseUrl)?.[id] ?? id) : "";
    }

    contextWindow(): number {
        const id = this.model();
        return getDiscoveredContext(this.cfg.baseUrl)?.[id] || contextWindowFor(id);
    }

    headers(loginToken?: string | null): Record<string, string> {
        return buildHeaders(this.cfg, loginToken);
    }

    authToken(forceRefresh = false): Promise<string | null> {
        return resolveAuthToken(this.cfg, forceRefresh);
    }

    async discoverModels(loginToken?: string | null): Promise<void> {
        await discoverModelsFromCatalog(this.cfg, this.backend, loginToken);
    }

    shellExecutionMode(): ShellExecutionMode {
        const configured = (this.cfg as { shellExecution?: string }).shellExecution;
        const value = String(this.options.execDisplay ?? configured ?? "silent");
        return value === "inline" || value === "terminal" ? value : "silent";
    }

    resolveToolPath(value: unknown): string | undefined {
        if (typeof value !== "string" || !value) {
            return undefined;
        }
        return path.isAbsolute(value) ? value : path.resolve(this.options.cwd, value);
    }

    requestEstimateEvent(estimate: RequestEstimate): Record<string, unknown> {
        const model = this.model();
        return {
            kind: "usage",
            inputTokens: estimate.inputTokens,
            outputTokens: 0,
            totalTokens: estimate.inputTokens,
            cacheRead: 0,
            contextWindow: this.contextWindow(),
            estimated: true,
            requestChars: estimate.requestChars,
            requestMessageCount: estimate.messageCount,
            requestToolCount: estimate.toolCount,
            model,
            modelLabel: this.label(model),
            requestedModel: model,
        };
    }
}

/** Builds the request-only reminder appended after long tool loops. */
export function buildFollowupAnchor(
    objective: string,
    progress: readonly string[],
): ChatMessage | undefined {
    if (!objective) {
        return undefined;
    }
    const lines = [
        "[Continuous focus — your context window is small, so treat THIS as the source of truth for the current task. This YIELDS to the latest user message: if the user redirects, narrows, or cancels, follow their request, not this objective.]",
        "OBJECTIVE: " + objective,
    ];
    if (progress.length) {
        const recent = progress.slice(-6);
        lines.push(`PROGRESS so far (${progress.length} steps; last ${recent.length}):`);
        for (const step of recent) {
            lines.push("  • " + step);
        }
    }
    lines.push(
        "GUIDANCE: Every tool call must move the OBJECTIVE forward — if a step doesn't, stop and reconsider. The moment the objective is met, STOP calling tools and reply to the user. If you've taken several steps without replying, lead your next message with a one-line status. But if the latest user message contradicts the OBJECTIVE (stop, don't do this now, just verify, change of subject), follow the user — this anchor is subordinate.",
    );
    return { role: "system", content: lines.join("\n") };
}
