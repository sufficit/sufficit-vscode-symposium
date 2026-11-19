/**
 * A classified hub failure. `status` is undefined for transport-level failures
 * (deadline exceeded, fetch refused) where no HTTP response existed.
 */
export class HubRequestError extends Error {
    readonly status?: number;
    readonly reasonCode?: string;
    readonly requiredPermission?: string;

    constructor(
        message: string,
        details: { status?: number; reasonCode?: string; requiredPermission?: string } = {},
    ) {
        super(message);
        this.name = "HubRequestError";
        this.status = details.status;
        this.reasonCode = details.reasonCode;
        this.requiredPermission = details.requiredPermission;
    }

    get accessNotice(): string | undefined {
        if (this.status === 401) {
            return "The hub could not authenticate this request. Check the configured hub credential or reconnect the Sufficit account.";
        }
        if (this.status === 403) {
            return "The hub denied access to this operation. Check the record's session and context, and any required permission, before retrying.";
        }
        return undefined;
    }

    /** Transport/server class: the exact same request may succeed moments later. */
    get retryable(): boolean {
        if (this.status === undefined) return true;
        return (
            this.status >= 500 || this.status === 408 || this.status === 425 || this.status === 429
        );
    }
}

/** Normalizes any thrown value into a HubRequestError (pass-through when it already is one). */
export function toHubRequestError(error: unknown): HubRequestError {
    if (error instanceof HubRequestError) return error;
    return new HubRequestError(error instanceof Error ? error.message : String(error));
}

/**
 * The JSON payload returned to the model when a memory/task hub operation
 * fails. Never invents success and never silently falls back to local storage:
 * the agent must see WHY the write failed and what to do about it.
 *
 * `extra` fields (partial ids, counts) are merged in for context.
 */
export function hubFailurePayload(
    operation: string,
    error: unknown,
    extra?: Record<string, unknown>,
): string {
    const hubError = toHubRequestError(error);
    const accessNotice = hubError.accessNotice;
    const retryable = hubError.retryable;
    const payload: Record<string, unknown> = {
        error: `${operation} failed: ${hubError.message}`,
        retryable,
        _memory_source:
            hubError.status === 401
                ? "auth_required"
                : hubError.status === 403
                  ? "permission_denied"
                  : "remote_unavailable",
        _notice: accessNotice
            ? accessNotice
            : retryable
              ? "Hub request failed temporarily or the network is unavailable. For a failed write, check whether it was saved before retrying; for a read, retry after checking the connection. No local fallback was read or written."
              : "Hub rejected this request. Check the request parameters before retrying. No local fallback was read or written.",
    };
    if (extra) Object.assign(payload, extra);
    return JSON.stringify(payload);
}

/**
 * Best-effort parse of a hub error body ({ error: { reasonCode, requiredPermission } } or plain text).
 */
function parseErrorBody(text: string): { reasonCode?: string; requiredPermission?: string } {
    try {
        const parsed = JSON.parse(text) as {
            error?: { reasonCode?: unknown; requiredPermission?: unknown } | string;
        };
        if (typeof parsed?.error !== "object" || parsed.error === null) {
            return {};
        }
        const reasonCode =
            typeof parsed.error.reasonCode === "string" ? parsed.error.reasonCode : undefined;
        const requiredPermission =
            typeof parsed.error.requiredPermission === "string"
                ? parsed.error.requiredPermission
                : undefined;
        return { reasonCode, requiredPermission };
    } catch {
        return {};
    }
}

/**
 * Builds the classified error for a non-OK hub response, preserving the HTTP
 * status plus the server's reasonCode/requiredPermission when present.
 */
export function hubStatusError(operation: string, res: Response, body: string): HubRequestError {
    const { reasonCode, requiredPermission } = parseErrorBody(body);
    const detail =
        reasonCode || requiredPermission
            ? ` (${[
                  reasonCode ? `reason ${reasonCode}` : "",
                  requiredPermission ? `missing ${requiredPermission}` : "",
              ]
                  .filter(Boolean)
                  .join(", ")})`
            : "";
    return new HubRequestError(`${operation} rejected: HTTP ${res.status}${detail}`, {
        status: res.status,
        reasonCode,
        requiredPermission,
    });
}
