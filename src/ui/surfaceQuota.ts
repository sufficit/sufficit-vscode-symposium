import type { AdapterUsageProvider, AgentAdapter } from "../adapters/types";
import { symposiumLog } from "../extension/log";
import { withAbortableDeadline } from "../sync/requestDeadline";
import { presetQuotaLoadingEvent } from "./chatSurfaceContext";

interface SurfaceQuotaDeps {
    post: (message: unknown) => void;
    getModel: () => string | undefined;
    timeoutMilliseconds?: number;
}

export class SurfaceQuota {
    private usage: AdapterUsageProvider | undefined;
    private model: string | null | undefined;
    private generation = 0;
    private timer: ReturnType<typeof setInterval> | undefined;
    private refreshInFlight: Promise<void> | undefined;

    constructor(private readonly deps: SurfaceQuotaDeps) {}

    activate(adapter: AgentAdapter): void {
        this.usage = adapter.usage;
        this.model = null;
        this.generation++;
        this.refreshInFlight = undefined;
        void this.refresh();
    }

    startAutoRefresh(): void {
        this.timer ??= setInterval(() => void this.refresh(), 60_000);
    }

    refresh(force = false): Promise<void> {
        if (this.refreshInFlight) return this.refreshInFlight;
        const generation = this.generation;
        return (this.refreshInFlight = this.runRefresh(force, generation).finally(() => {
            if (generation === this.generation) this.refreshInFlight = undefined;
        }));
    }

    private async runRefresh(force: boolean, generation: number): Promise<void> {
        const usage = this.usage;
        if (!usage) return;
        const model = this.deps.getModel();
        if (usage.backend === "openai" && model !== this.model) {
            this.model = model;
            this.deps.post(presetQuotaLoadingEvent(usage));
        }
        this.deps.post({ type: "quota-loading", loading: true });
        let failed = false;
        try {
            const snapshot = await withAbortableDeadline(
                "quota",
                this.deps.timeoutMilliseconds ?? 15_000,
                () => usage.read(force, { model }),
            );
            if (!this.isCurrent(generation, usage)) return;
            this.deps.post({ type: "event", event: { kind: "quota", ...snapshot } });
        } catch (error) {
            if (!this.isCurrent(generation, usage)) return;
            failed = true;
            symposiumLog(`[quota] Read: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            if (this.isCurrent(generation, usage)) {
                this.deps.post({
                    type: "quota-loading",
                    loading: false,
                    backend: usage.backend,
                    ...(failed ? { error: true } : {}),
                });
            }
        }
    }

    dispose(): void {
        clearInterval(this.timer);
        this.timer = undefined;
        this.generation++;
        this.usage = undefined;
        this.refreshInFlight = undefined;
    }

    private isCurrent(generation: number, usage: AdapterUsageProvider): boolean {
        return generation === this.generation && usage === this.usage;
    }
}
