/** Monotonic guard that invalidates cleanup from a replaced async run. */
export class RunSequence {
    private value = 0;

    start(): () => boolean {
        const value = ++this.value;
        return () => value === this.value;
    }
}
