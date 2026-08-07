/**
 * Some OpenAI-compatible gateways put chain-of-thought in `content`, wrapped
 * in `<think>…</think>`, instead of using the reasoning fields. Keep that
 * implementation detail out of the transcript and webview.
 *
 * SSE tokens can split a tag at any character, so this is stateful rather than
 * applying a regular expression to each individual delta.
 */
export class ThinkingContentFilter {
    private pending = "";
    private insideThink = false;

    push(delta: string): string {
        this.pending += delta;
        let visible = "";

        for (;;) {
            const match = /<\/?think\s*>/i.exec(this.pending);
            if (!match) {
                const tail = this.partialTagTail();
                const complete = this.pending.slice(0, this.pending.length - tail.length);
                if (!this.insideThink) {
                    visible += complete;
                }
                this.pending = tail;
                return visible;
            }

            if (!this.insideThink) {
                visible += this.pending.slice(0, match.index);
            }
            this.insideThink = /^<\/think/i.test(match[0]) ? false : true;
            this.pending = this.pending.slice(match.index + match[0].length);
        }
    }

    /** Flushes a completed stream without ever exposing a partial think tag. */
    finish(): string {
        const trailing = this.pending;
        this.pending = "";
        return this.insideThink ? "" : trailing;
    }

    private partialTagTail(): string {
        const lower = this.pending.toLowerCase();
        for (const tag of ["</think>", "<think>"]) {
            for (let length = Math.min(tag.length - 1, lower.length); length > 0; length--) {
                if (lower.endsWith(tag.slice(0, length))) {
                    return this.pending.slice(-length);
                }
            }
        }
        return "";
    }
}
