/**
 * Messages the host has reported as dispatched, so the Queued panel can refuse
 * to list them.
 *
 * The pending row has several independent producers (the AHP transport's
 * optimistic action, the host queue projection, a restored ChatState) and each
 * carries its own id, which is why an id-keyed guard alone has repeatedly let a
 * ghost row through: when the ids do not line up, nothing matches. The text is
 * the one thing every producer agrees on, so it is tracked as well.
 *
 * DOM-free on purpose — this is the rule the user sees, so it is unit-tested.
 */

const MAX_TEXTS = 50;

const ids = new Set<string>();
const texts: string[] = [];
const textSet = new Set<string>();

export function markMessageDispatched(clientMessageId?: string, text?: string): void {
    if (clientMessageId) {
        ids.add(clientMessageId);
    }
    if (!text || textSet.has(text)) {
        return;
    }
    texts.push(text);
    textSet.add(text);
    if (texts.length > MAX_TEXTS) {
        const evicted = texts.shift();
        if (evicted !== undefined) {
            textSet.delete(evicted);
        }
    }
}

export function wasMessageDispatched(clientMessageId?: string, text?: string): boolean {
    if (clientMessageId && ids.has(clientMessageId)) {
        return true;
    }
    return !!text && textSet.has(text);
}

/** Session switch / transcript reset: these belong to the previous dialogue. */
export function resetDispatchedMessages(): void {
    ids.clear();
    texts.length = 0;
    textSet.clear();
}
