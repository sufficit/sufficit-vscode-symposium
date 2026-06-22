/**
 * Optional Sufficit login access-token provider. When set (at activation) and an
 * adapter has no explicit apiKey/Authorization, the logged-in token is used as
 * the Bearer — so the native "Sufficit AI" backend works right after login with
 * no manual config.
 */
let openaiTokenProvider: (() => Promise<string | null>) | undefined;

export function setOpenAITokenProvider(fn: () => Promise<string | null>): void {
    openaiTokenProvider = fn;
}

export function getOpenAITokenProvider(): (() => Promise<string | null>) | undefined {
    return openaiTokenProvider;
}
