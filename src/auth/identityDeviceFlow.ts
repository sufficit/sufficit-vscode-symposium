import { OAuthTokenResponse } from "./identityTokenManager";
import { isTransientOAuthStatus, OAuthHttpError, parseOAuthJson } from "./oauthHttp";

interface DeviceTokenPayload extends OAuthTokenResponse {
    error?: string;
    error_description?: string;
}

interface PollDeviceTokenOptions {
    tokenEndpoint: string;
    clientId: string;
    deviceCode: string;
    intervalSec: number;
    expiresInSec: number;
    isCancelled?: () => boolean;
    log?: (message: string) => void;
    fetchImpl?: typeof fetch;
    sleep?: (milliseconds: number) => Promise<void>;
    now?: () => number;
}

/** Polls the OAuth Device Flow endpoint, tolerating only transient transport failures. */
export async function pollDeviceToken(options: PollDeviceTokenOptions): Promise<OAuthTokenResponse | undefined> {
    const fetchImpl = options.fetchImpl ?? fetch;
    const sleep = options.sleep ?? ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
    const now = options.now ?? Date.now;
    const deadline = now() + options.expiresInSec * 1000;
    let interval = options.intervalSec;

    while (now() < deadline && !options.isCancelled?.()) {
        await sleep(interval * 1000);
        let response: Response;
        try {
            response = await fetchImpl(options.tokenEndpoint, {
                method: "POST",
                headers: { "content-type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({
                    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
                    device_code: options.deviceCode,
                    client_id: options.clientId,
                }).toString(),
            });
        } catch (error) {
            options.log?.(`[auth] device token request failed transiently; polling will continue: ${error}`);
            continue;
        }

        let payload: DeviceTokenPayload;
        try {
            payload = await parseOAuthJson<DeviceTokenPayload>(response, "Sufficit device token endpoint");
        } catch (error) {
            if (error instanceof OAuthHttpError && error.transient) {
                options.log?.(`[auth] ${error.message}; polling will continue.`);
                continue;
            }
            throw error;
        }

        if (response.ok) { return payload; }
        if (isTransientOAuthStatus(response.status)) {
            options.log?.(`[auth] device token endpoint returned transient HTTP ${response.status}; polling will continue.`);
            continue;
        }
        if (payload.error === "authorization_pending") { continue; }
        if (payload.error === "slow_down") { interval += 5; continue; }
        options.log?.(`[auth] device token error: ${payload.error ?? `HTTP ${response.status}`}`);
        throw new OAuthHttpError(
            payload.error_description ?? payload.error ?? `Device login failed: HTTP ${response.status}`,
            response.status,
            false,
        );
    }
    return undefined;
}
