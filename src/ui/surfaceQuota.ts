import type { AdapterUsageProvider, AgentAdapter } from "../adapters/types";
import { symposiumLog } from "../extension/log";
import { presetQuotaLoadingEvent } from "./chatSurfaceContext";

interface SurfaceQuotaDeps {
    post: (message: unknown) => void;
    getModel: () => string | undefined;
}

export class SurfaceQuota {
    private usage: AdapterUsageProvider | undefined;
    private model: string | null | undefined;
    private generation = 0;
    private timer: ReturnType<typeof setInterval> | undefined;

    constructor(private readonly deps: SurfaceQuotaDeps) {}

    activate(adapter: AgentAdapter): void {
        this.usage = adapter.usage;
        this.model = null;
        this.generation++;
        void this.refresh();
    }

    startAutoRefresh(): void {
        this.timer ??= setInterval(() => void this.refresh(), 60_000);
    }

    async refresh(force = false): Promise<void> {
        const usage = this.usage;
        if (!usage) return;
        const generation = this.generation;
        const model = this.deps.getModel();
        if (usage.backend === "openai" && model !== this.model) {
            this.model = model;
            this.deps.post(presetQuotaLoadingEvent(usage));
        }
        this.deps.post({ type: "quota-loading", loading: true });
        try {
            const snapshot = await usage.read(force, { model });
            if (!this.isCurrent(generation, usage)) return;
            this.deps.post({ type: "event", event: { kind: "quota", ...snapshot } });
        } catch (error) {
            if (!this.isCurrent(generation, usage)) return;
            symposiumLog(
                `[quota] Failed to read local adapter usage: ${error instanceof Error ? error.message : String(error)}`,
            );
            this.deps.post({
                type: "quota-loading",
                loading: false,
                backend: usage.backend,
                error: true,
            });
        } finally {
            if (this.isCurrent(generation, usage)) {
                this.deps.post({ type: "quota-loading", loading: false, backend: usage.backend });
            }
        }
    }

    dispose(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = undefined;
    }

    private isCurrent(generation: number, usage: AdapterUsageProvider): boolean {
        return generation === this.generation && usage === this.usage;
    }
}
