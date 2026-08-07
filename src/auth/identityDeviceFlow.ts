import { OAuthTokenResponse } from "./identityTokenManager";
import { isTransientOAuthStatus, OAuthHttpError, parseOAuthJson } from "./oauthHttp";

interface DeviceTokenPayload extends OAuthTokenResponse {
    error?: string;
    error_description?: string;
}

export interface DeviceAuthorization {
    verification_uri_complete?: string;
    verification_uri?: string;
    user_code: string;
    error?: string;
    device_code?: string;
    interval?: number;
    expires_in?: number;
}

export async function requestDeviceAuthorization(
    endpoint: string,
    clientId: string,
    scope: string,
): Promise<DeviceAuthorization> {
    const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: clientId, scope }).toString(),
    });
    const payload = await parseOAuthJson<DeviceAuthorization>(
        response,
        "Sufficit device authorization endpoint",
    );
    if (!response.ok) {
        throw new Error(`device authorization failed: ${payload.error ?? response.status}`);
    }
    return payload;
}

export async function presentDeviceAuthorization(
    device: DeviceAuthorization,
    showUrlModal: (url: string, userCode: string) => Promise<void>,
): Promise<void> {
    const url = device.verification_uri_complete ?? device.verification_uri ?? "";
    if (vscode.env.uiKind === vscode.UIKind.Web) {
        let opened = false;
        try {
            opened = await vscode.env.openExternal(vscode.Uri.parse(url));
        } catch {
            opened = false;
        }
        if (!opened) await showUrlModal(url, device.user_code);
        return;
    }
    const pick = await vscode.window.showInformationMessage(
        `Sufficit: open the browser and confirm the code ${device.user_code}`,
        "Open browser",
        "Copy URL",
    );
    if (pick === "Copy URL") {
        await showUrlModal(url, device.user_code);
        return;
    }
    if (pick === "Open browser") {
        try {
            if (!(await vscode.env.openExternal(vscode.Uri.parse(url)))) {
                await showUrlModal(url, device.user_code);
            }
        } catch {
            await showUrlModal(url, device.user_code);
        }
    }
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
export async function pollDeviceToken(
    options: PollDeviceTokenOptions,
): Promise<OAuthTokenResponse | undefined> {
    const fetchImpl = options.fetchImpl ?? fetch;
    const sleep =
        options.sleep ??
        ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
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
            options.log?.(
                `[auth] device token request failed transiently; polling will continue: ${error}`,
            );
            continue;
        }

        let payload: DeviceTokenPayload;
        try {
            payload = await parseOAuthJson<DeviceTokenPayload>(
                response,
                "Sufficit device token endpoint",
            );
        } catch (error) {
            if (error instanceof OAuthHttpError && error.transient) {
                options.log?.(`[auth] ${error.message}; polling will continue.`);
                continue;
            }
            throw error;
        }

        if (response.ok) {
            return payload;
        }
        if (isTransientOAuthStatus(response.status)) {
            options.log?.(
                `[auth] device token endpoint returned transient HTTP ${response.status}; polling will continue.`,
            );
            continue;
        }
        if (payload.error === "authorization_pending") {
            continue;
        }
        if (payload.error === "slow_down") {
            interval += 5;
            continue;
        }
        options.log?.(`[auth] device token error: ${payload.error ?? `HTTP ${response.status}`}`);
        throw new OAuthHttpError(
            payload.error_description ??
                payload.error ??
                `Device login failed: HTTP ${response.status}`,
            response.status,
            false,
        );
    }
    return undefined;
}
import * as vscode from "vscode";
