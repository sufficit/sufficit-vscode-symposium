import assert from "node:assert/strict";
import { test } from "node:test";
import { deviceBrowserUrl } from "../auth/identityDeviceBrowser";

test("Identity device URL opens a same-origin popup launcher without untrusted return data", () => {
    const result = new URL(
        deviceBrowserUrl(
            "https://identity.sufficit.com.br/connect/device?user_code=ABCD-EFGH&returnUrl=https://evil.invalid#token",
            "OTHER",
        ),
    );
    assert.equal(result.origin, "https://identity.sufficit.com.br");
    assert.equal(result.pathname, "/device/launch");
    assert.equal(result.searchParams.get("user_code"), "ABCD-EFGH");
    assert.equal(result.searchParams.get("launch_mode"), "popup");
    assert.equal(result.searchParams.size, 2);
    assert.equal(result.hash, "");
});

test("base verification URI carries the issued code; unrelated providers keep their route", () => {
    assert.equal(
        new URL(
            deviceBrowserUrl("https://identity.example/connect/device", "ABCD EFGH"),
        ).searchParams.get("user_code"),
        "ABCD EFGH",
    );
    for (const url of ["https://other.example/activate", "ftp://identity.example/connect/device"]) {
        assert.equal(deviceBrowserUrl(url, "ABCD-EFGH"), url);
    }
    const url = "https://identity.example/connect/device";
    for (const code of ["", "<script>", "A".repeat(65)])
        assert.equal(deviceBrowserUrl(url, code), url);
});

import * as vscode from "vscode";
import { presentDeviceAuthorization } from "../auth/identityDeviceFlow";

test("desktop and web open the launcher; copy and blocked-open retain a usable URL", async () => {
    const env = vscode.env as unknown as {
        uiKind: number;
        openExternal: (uri: vscode.Uri) => Promise<boolean>;
    };
    const win = vscode.window as unknown as { showInformationMessage: () => Promise<string> };
    const previous = {
        kind: env.uiKind,
        open: env.openExternal,
        message: win.showInformationMessage,
    };
    const urls: string[] = [];
    const copied: string[] = [];
    const device = {
        verification_uri_complete:
            "https://identity.sufficit.com.br/connect/device?user_code=ABCD-EFGH",
        user_code: "ABCD-EFGH",
    };
    try {
        env.openExternal = (uri) => {
            urls.push(uri.toString());
            return Promise.resolve(true);
        };
        win.showInformationMessage = () => Promise.resolve("Open browser");
        for (const kind of [vscode.UIKind.Desktop, vscode.UIKind.Web]) {
            env.uiKind = kind;
            await presentDeviceAuthorization(device, (url) => {
                copied.push(url);
                return Promise.resolve();
            });
        }
        assert.equal(urls.length, 2);
        assert(urls.every((url) => new URL(url).pathname === "/device/launch"));
        env.openExternal = () => Promise.resolve(false);
        await presentDeviceAuthorization(device, (url) => {
            copied.push(url);
            return Promise.resolve();
        });
        env.uiKind = vscode.UIKind.Desktop;
        win.showInformationMessage = () => Promise.resolve("Copy URL");
        await presentDeviceAuthorization(device, (url) => {
            copied.push(url);
            return Promise.resolve();
        });
        assert.equal(copied.length, 2);
        assert(copied.every((url) => new URL(url).pathname === "/device/launch"));
    } finally {
        env.uiKind = previous.kind;
        env.openExternal = previous.open;
        win.showInformationMessage = previous.message;
    }
});
