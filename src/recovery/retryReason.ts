/**
 * Converts an untrusted provider error into a bounded reason suitable for a
 * system notice and the retry continuity prompt. Provider gateways may return
 * complete HTML maintenance pages; those must remain technical error detail,
 * never conversation content.
 */
export function conciseRetryReason(message: unknown): string {
    const raw = String(message ?? "").trim();
    const status = /\bHTTP\s+\d{3}(?:\s+[A-Za-z][^<\n\r]{0,100})?/i.exec(raw)?.[0]?.trim();
    if (status) return status;
    if (/<(?:!doctype|html)\b/i.test(raw)) return "temporary provider failure";
    const readable = raw
        .replace(/<[^>]*>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    if (!readable) return "temporary provider failure";
    return readable.length > 240 ? `${readable.slice(0, 237)}…` : readable;
}
