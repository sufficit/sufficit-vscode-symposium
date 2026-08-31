import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { configViews } from "../ui/configViews";

test("transient retry policy is exported and configurable from Preferences", () => {
    const manifest = JSON.parse(
        fs.readFileSync(path.join(__dirname, "../../package.json"), "utf8"),
    ) as {
        contributes: { configuration: { properties: Record<string, { default?: unknown }> } };
    };
    const properties = manifest.contributes.configuration.properties;

    assert.equal(properties["symposium.transientRetryLimit"]?.default, 3);
    assert.equal(properties["symposium.retryInitialDelayMilliseconds"]?.default, 1_000);
    assert.match(configViews, /symposium\.transientRetryLimit/);
    assert.match(configViews, /symposium\.retryInitialDelayMilliseconds/);
});
