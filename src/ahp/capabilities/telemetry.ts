import { AHP_CAPABILITIES, AhpCapabilityRegistry } from "./registry";

export interface AhpMeasurement {
    name: AhpMetricName;
    value: number;
    timestamp: number;
    labels: Record<string, string>;
}

export type AhpMetricName =
    | "ahp.lifecycle.latency_ms"
    | "ahp.reconnect.count"
    | "ahp.replay.actions"
    | "ahp.projection.mismatch"
    | "ahp.backpressure.count"
    | "ahp.action.rejected";

export interface AhpTelemetryExporter {
    export(measurements: readonly AhpMeasurement[]): Promise<void>;
}

export interface AhpTelemetryOptions {
    enabled: boolean;
    consent: boolean;
    sampleRate?: number;
    maxQueue?: number;
    allowedLabels?: Record<string, readonly string[]>;
    exporter?: AhpTelemetryExporter;
}

/** Ephemeral OTLP-shaped measurements isolated from protocol state and replay. */
export class AhpTelemetry {
    private readonly queue: AhpMeasurement[] = [];
    private readonly sampleRate: number;
    private readonly maxQueue: number;
    private flushing = false;

    constructor(
        capabilities: AhpCapabilityRegistry,
        private readonly options: AhpTelemetryOptions,
    ) {
        this.sampleRate = Math.max(0, Math.min(1, options.sampleRate ?? 1));
        this.maxQueue = positive(options.maxQueue, 500);
        capabilities.set(AHP_CAPABILITIES.telemetry, this.active);
    }

    get active(): boolean {
        return this.options.enabled && this.options.consent && !!this.options.exporter;
    }

    measure(name: AhpMetricName, value: number, labels: Record<string, string> = {}): void {
        if (!this.active || Math.random() > this.sampleRate || !Number.isFinite(value)) return;
        this.queue.push({
            name,
            value,
            timestamp: Date.now(),
            labels: boundedLabels(labels, this.options.allowedLabels ?? {}),
        });
        if (this.queue.length > this.maxQueue) this.queue.shift();
    }

    pending(): number {
        return this.queue.length;
    }

    flush(): void {
        if (!this.active || this.flushing || !this.queue.length) return;
        const batch = this.queue.splice(0, this.queue.length);
        this.flushing = true;
        void this.options
            .exporter!.export(batch)
            .catch(() => undefined)
            .finally(() => {
                this.flushing = false;
            });
    }
}

function boundedLabels(
    values: Record<string, string>,
    allowed: Record<string, readonly string[]>,
): Record<string, string> {
    const output: Record<string, string> = {};
    for (const [key, value] of Object.entries(values).slice(0, 12)) {
        const accepted = allowed[key];
        if (!accepted?.includes(value)) continue;
        output[key.slice(0, 40)] = value.slice(0, 80);
    }
    return output;
}

function positive(value: number | undefined, fallback: number): number {
    return Number.isSafeInteger(value) && (value ?? 0) > 0 ? (value as number) : fallback;
}
