/**
 * Ids the host has reported as dispatched, so the Queued panel can refuse to
 * list them: a message already in the transcript is not pending.
 *
 * Matched by id ONLY. Matching by text as well looks tempting — the producers
 * of a pending row do not always agree on an id — but the same text is
 * legitimately queued several times in a row, and a text rule then hides real
 * pending work. Showing every genuinely queued message matters more than
 * catching a row whose id nothing else recognises.
 */

const ids = new Set<string>();

export function markMessageDispatched(clientMessageId?: string): void {
    if (clientMessageId) {
        ids.add(clientMessageId);
    }
}

export function wasMessageDispatched(clientMessageId?: string): boolean {
    return !!clientMessageId && ids.has(clientMessageId);
}

/** Session switch / transcript reset: these belong to the previous dialogue. */
export function resetDispatchedMessages(): void {
    ids.clear();
}
