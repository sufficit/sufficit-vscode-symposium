/**
 * Classifies an error message as transient (network/transport failure) vs.
 * a logic/permission/4xx error. Transient failures are safe to retry with the
 * exact same request; the Retry button (see messages.ts) only renders when an
 * error event is marked `retryable: true`. Shared across all adapters so
 * Claude/Codex/Copilot get the same Retry affordance the OpenAI adapter
 * already had — a CLI process exit or dropped stdio pipe is just as
 * transient as a fetch failure.
 */
export function isTransientErrorMessage(message: string): boolean {
    return /fetch failed|network error|network request failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|ECONNABORTED|EPROTO|EPIPE|socket hang up|terminated|aborted|timeout|request timed out|connection refused|connection reset|getaddrinfo|stream ended|unexpected end of|process exited|spawn .* enoent|premature close/i.test(
        message,
    );
}
