/** Keeps verbose diagnostics useful without flooding the Extension Host log. */
export class DiagnosticThrottle {
    private lastEmittedAt: number | undefined;
    private lastValue: string | undefined;

    constructor(
        private readonly minimumIntervalMs = 30_000,
        private readonly now: () => number = Date.now,
    ) {}

    shouldEmit(value: string, force = false): boolean {
        if (!force && value === this.lastValue) return false;
        const current = this.now();
        if (
            !force &&
            this.lastEmittedAt !== undefined &&
            current - this.lastEmittedAt < this.minimumIntervalMs
        ) {
            return false;
        }
        this.lastValue = value;
        this.lastEmittedAt = current;
        return true;
    }
}
