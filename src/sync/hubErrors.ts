/**
 * Error classification for Sufficit Hub (memory/task REST) failures.
 *
 * Motivation (incident 2026-10-04, AcessoPoint): a 403 "scope_required" from
 * the hub was surfaced to agents and users as "save failed - check hub
 * configuration" or as a generic 15s-timeout wording, sending NOC engineers to
 * hunt for hub outages without evidence. A 403 tells us the permission was
 * missing from the token on that request; a renewed session may resolve it.
 * These carriers preserve the HTTP status and the server's
 * reasonCode/requiredPermission so every layer (tool result, retry affordance,
 * logs) can distinguish "reconnect the account" from "hub unreachable".
 */

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

    /** Auth/permission rejection (401/403): the SAME request cannot succeed until the account is reconnected. */
    get permissionProblem(): boolean {
        return this.status === 401 || this.status === 403;
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
    const permission = hubError.permissionProblem;
    const retryable = hubError.retryable;
    const payload: Record<string, unknown> = {
        error: `${operation} failed: ${hubError.message}`,
        retryable,
        _memory_source: permission ? "auth_required" : "remote_unavailable",
        _notice: permission
            ? "AUTH/PERMISSION PROBLEM: this hub request was rejected with 401/403. Reconnect the Sufficit account to renew the token, then retry. This rejection is not evidence of a hub outage. No local fallback was read or written."
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
 * status plus the server's reasonCode/requiredPermission when present, so
 * callers can tell "reconnect the account" (403) from "hub unreachable".
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
