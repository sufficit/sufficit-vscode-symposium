/** Serializes configuration translations for safe embedding in a script tag. */
export function serializeConfigI18n(dict: Record<string, string>): string {
    return JSON.stringify(dict)
        .replace(/</g, "\\u003c")
        .replace(/\u2028/g, "\\u2028")
        .replace(/\u2029/g, "\\u2029");
}
