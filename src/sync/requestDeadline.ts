export const HUB_REQUEST_TIMEOUT_MS = 15_000;

/**
 * Bounds an async request including its authentication/header preparation.
 * AbortSignal stops fetch once it has started; Promise.race also releases the
 * caller when the operation is stuck before fetch (for example in a token
 * provider), so optional Hub context can never freeze an agent dispatch.
 */
export async function withAbortableDeadline<T>(
    label: string,
    timeoutMs: number,
    operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
            controller.abort();
            reject(new Error(`${label} timed out after ${timeoutMs} ms`));
        }, timeoutMs);
    });
    try {
        return await Promise.race([operation(controller.signal), timeout]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}
