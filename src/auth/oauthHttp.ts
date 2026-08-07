/** HTTP/JSON helpers shared by the Sufficit OAuth flows. */

const TRANSIENT_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

export class OAuthHttpError extends Error {
    readonly status: number;
    readonly transient: boolean;

    constructor(message: string, status: number, transient = isTransientOAuthStatus(status)) {
        super(message);
        this.name = "OAuthHttpError";
        this.status = status;
        this.transient = transient;
    }
}

export function isTransientOAuthStatus(status: number): boolean {
    return TRANSIENT_STATUSES.has(status) || (status >= 500 && status <= 599);
}

function responsePreview(body: string): string {
    return body
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/gi, " ")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&amp;/gi, "&")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 160);
}

/**
 * Reads an OAuth response exactly once and preserves useful HTTP context when
 * a proxy, WAF or upstream service returns HTML instead of JSON.
 */
export async function parseOAuthJson<T>(response: Response, stage: string): Promise<T> {
    const body = await response.text();
    if (body.trim()) {
        try {
            return JSON.parse(body) as T;
        } catch {
            // Report a safe body summary below; never expose JSON.parse's opaque
            // "Unexpected token '<'" as the login failure.
        }
    }

    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
    const preview = responsePreview(body);
    const detail = preview ? `: ${preview}` : ": empty response";
    throw new OAuthHttpError(
        `${stage} returned non-JSON (HTTP ${response.status}${contentType ? `, ${contentType}` : ""})${detail}`,
        response.status,
    );
}
