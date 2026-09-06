/**
 * User-facing description for a terminal backend error. Keep the complete
 * provider payload separate: gateways often return nested JSON that is useful
 * for support but far too noisy to be the only thing a user sees in chat.
 */
export interface ErrorPresentation {
    summary: string;
    detail: string;
}

const MAX_TECHNICAL_DETAIL_LENGTH = 512;

function decodeHtmlEntities(value: string): string {
    return value
        .replace(/&nbsp;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/&#(\d+);/g, (_match, code: string) => {
            const value = Number(code);
            return Number.isFinite(value) ? String.fromCodePoint(value) : "";
        });
}

/** Keeps gateway maintenance pages out of the conversation while preserving a useful clue. */
function compactTechnicalDetail(message: unknown): string {
    const raw = String(message ?? "").trim();
    if (!raw) return "The request ended without an error detail from the backend.";

    const html = /<!doctype\b|<html\b|<head\b|<body\b|<style\b|<script\b|<\/?[a-z][^>]*>/i.test(
        raw,
    );
    if (!html) {
        return raw.length > MAX_TECHNICAL_DETAIL_LENGTH
            ? `${raw.slice(0, MAX_TECHNICAL_DETAIL_LENGTH - 1)}…`
            : raw;
    }

    const status = /\bHTTP\s+\d{3}(?:\s+[A-Za-z][^<\n\r]{0,100})?/i.exec(raw)?.[0]?.trim();
    const title = decodeHtmlEntities(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(raw)?.[1] || "")
        .replace(/\s+/g, " ")
        .trim();
    const visible = decodeHtmlEntities(
        raw
            .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
            .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
            .replace(/<[^>]*>/g, " "),
    )
        .replace(/\s+/g, " ")
        .trim();
    const descriptor = title || visible || "provider returned an HTML error page";
    const withoutStatus = status ? descriptor.replace(status, "").trim() : descriptor;
    const result = [status, withoutStatus].filter(Boolean).join(" — ");
    return result.length > MAX_TECHNICAL_DETAIL_LENGTH
        ? `${result.slice(0, MAX_TECHNICAL_DETAIL_LENGTH - 1)}…`
        : result;
}

function httpStatus(message: string): number | undefined {
    const match = /\bHTTP\s+(\d{3})\b/i.exec(message);
    return match ? Number(match[1]) : undefined;
}

function requiredDirectives(message: string): string[] {
    const values: string[] = [];
    const array = /["']required_directives["']\s*:\s*\[([^\]]*)\]/i.exec(message)?.[1];
    if (array) {
        for (const match of array.matchAll(/["']([A-Za-z][A-Za-z0-9_.:-]{0,63})["']/g)) {
            values.push(match[1]);
        }
    }
    const header = /X-Sufficit-Required-Directive\s*:\s*([A-Za-z][A-Za-z0-9_.:-]{0,63})/i.exec(
        message,
    )?.[1];
    if (header) {
        values.push(header);
    }
    if (values.length === 0 && /\bAI\s*control\s+(?:access|directive)\b/i.test(message)) {
        values.push("AIControl");
    }
    return [...new Set(values)];
}

/**
 * Classifies an adapter error without exposing provider jargon as the primary
 * UI. This is presentation only: the exact error remains available in the
 * expandable technical-details section and on the Retry hand-off.
 */
export function presentTurnError(
    message: unknown,
    retryable?: boolean,
    retryAt?: number,
    now = Date.now(),
): ErrorPresentation {
    const detail = compactTechnicalDetail(message);
    const status = httpStatus(detail);
    const retry =
        retryable === true && typeof retryAt === "number" && retryAt > now
            ? " The provider limit is exhausted. Retry will become available when the stated reset time is reached."
            : retryable === true
              ? " Automatic recovery was unavailable or exhausted. You may retry the same message."
              : " Retry is unavailable for this response; update the request or configuration before sending again.";

    if (status === 503 && /ai_backends_exhausted|all ai backends exhausted/i.test(detail)) {
        return {
            summary:
                "The AI provider could not complete this request (HTTP 503: all configured backends were unavailable)." +
                retry,
            detail,
        };
    }
    if (status === 503) {
        return {
            summary: "The AI provider is temporarily unavailable (HTTP 503)." + retry,
            detail,
        };
    }
    if (status === 429) {
        return { summary: "The AI provider is rate-limiting requests (HTTP 429)." + retry, detail };
    }
    if (status === 408 || status === 504) {
        return { summary: `The request timed out (HTTP ${status}).` + retry, detail };
    }
    if (status === 401) {
        return {
            summary:
                "Authentication was rejected by the provider (HTTP 401). Sign in again before resending the message.",
            detail,
        };
    }
    if (status === 403) {
        const directives = requiredDirectives(detail);
        const permission =
            directives.length === 1
                ? ` Required directive: ${directives[0]}.`
                : directives.length > 1
                  ? ` Required directives: ${directives.join(", ")}.`
                  : " The provider did not identify the required directive.";
        return {
            summary:
                "Your account is signed in, but it does not have permission for this request (HTTP 403)." +
                permission +
                " Ask an administrator to grant access, then resend the message.",
            detail,
        };
    }
    return { summary: "The request ended before the agent could reply." + retry, detail };
}
