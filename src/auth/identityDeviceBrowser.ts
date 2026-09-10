/** Same-origin Identity launcher owns the popup even when VS Code uses openExternal. */
export function deviceBrowserUrl(verificationUri: string, userCode: string): string {
    const url = new URL(verificationUri);
    if (url.pathname !== "/connect/device" || !["https:", "http:"].includes(url.protocol)) {
        return verificationUri;
    }
    const code = url.searchParams.get("user_code") || userCode;
    if (!/^[A-Za-z0-9 -]{1,64}$/.test(code)) return verificationUri;
    url.pathname = "/device/launch";
    url.search = "";
    url.hash = "";
    url.searchParams.set("user_code", code);
    url.searchParams.set("launch_mode", "popup");
    return url.toString();
}
