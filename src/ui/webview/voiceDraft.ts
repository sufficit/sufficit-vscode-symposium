export class VoiceDraft {
    base = "";
    interim = "";
    private dots = "";
    private interval: ReturnType<typeof setInterval> | null = null;

    constructor(
        private readonly currentValue: () => string,
        private readonly write: (value: string) => void,
    ) {}

    reset(base = this.currentValue()): void {
        this.base = base;
        this.interim = "";
        this.dots = "";
    }

    render(): void {
        this.write(this.base + this.interim + this.dots);
    }

    startDots(): void {
        const frames = ["", ".", "..", "...", "..", "."];
        let index = 0;
        this.interval = setInterval(() => {
            index = (index + 1) % frames.length;
            this.dots = frames[index];
            this.render();
        }, 400);
    }

    stopDots(): void {
        if (this.interval) clearInterval(this.interval);
        this.interval = null;
        this.dots = "";
    }
}
