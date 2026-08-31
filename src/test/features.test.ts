import assert from "node:assert/strict";
import { test } from "node:test";
import { AHP_CAPABILITIES } from "../ahp/capabilities/registry";
import { CHANGESETS_FEATURE } from "../ahp/capabilities/changesets/feature";
import { CLIENT_TOOLS_FEATURE } from "../ahp/capabilities/clientTools/feature";
import { CUSTOMIZATIONS_FEATURE } from "../ahp/capabilities/customizations/feature";
import { RESOURCES_FEATURE } from "../ahp/capabilities/resources/feature";
import { TELEMETRY_FEATURE } from "../ahp/capabilities/telemetry/feature";
import { TERMINAL_FEATURE } from "../ahp/capabilities/terminal/feature";
import { AHP_FEATURE_VERSION } from "../ahp/feature";
import { AHP_PROTOCOL_VERSION } from "../ahp/persistenceValidation";
import { AHP_SUPPORTED_PROTOCOL_VERSIONS } from "../ahp/wireProtocol";
import { API_FEATURE_VERSION } from "../api/feature";
import { API_VERSION } from "../api/symposiumApi";
import {
    compareFeatureVersions,
    defineFeature,
    isFeatureVersionCompatible,
    supportsFeatureVersion,
    SYMPOSIUM_FEATURES,
    SYMPOSIUM_FEATURE_VERSIONS,
    type FeatureNamespace,
    type FeatureVersion,
} from "../features";

test("feature catalog exposes one frozen semantic version per namespace", () => {
    assert.equal(SYMPOSIUM_FEATURES.length, 25);
    assert.equal(Object.isFrozen(SYMPOSIUM_FEATURES), true);
    assert.equal(Object.isFrozen(SYMPOSIUM_FEATURE_VERSIONS), true);

    const namespaces = SYMPOSIUM_FEATURES.map((feature) => feature.namespace);
    assert.deepEqual(namespaces, [...namespaces].sort());
    assert.equal(new Set(namespaces).size, namespaces.length);
    assert.deepEqual(Object.keys(SYMPOSIUM_FEATURE_VERSIONS), namespaces);

    for (const feature of SYMPOSIUM_FEATURES) {
        assert.match(feature.namespace, /^symposium\./);
        assert.match(feature.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
        assert.equal(SYMPOSIUM_FEATURE_VERSIONS[feature.namespace], feature.version);
        assert.equal(Object.isFrozen(feature), true);
    }
});

test("feature version comparison follows stable and pre-1.0 compatibility rules", () => {
    assert.ok(compareFeatureVersions("1.2.0", "1.1.9") > 0);
    assert.equal(compareFeatureVersions("1.2.0", "1.2.0"), 0);
    assert.equal(isFeatureVersionCompatible("1.3.0", "1.2.1"), true);
    assert.equal(isFeatureVersionCompatible("2.0.0", "1.2.1"), false);
    assert.equal(isFeatureVersionCompatible("0.6.4", "0.6.0"), true);
    assert.equal(isFeatureVersionCompatible("0.7.0", "0.6.0"), false);
    assert.equal(
        supportsFeatureVersion(SYMPOSIUM_FEATURE_VERSIONS, "symposium.voice", "1.0.0"),
        true,
    );
    assert.equal(
        supportsFeatureVersion(
            SYMPOSIUM_FEATURE_VERSIONS,
            "symposium.unknown" as FeatureNamespace,
            "1.0.0",
        ),
        false,
    );
});

test("feature definitions reject malformed public metadata", () => {
    assert.throws(
        () =>
            defineFeature({
                namespace: "invalid" as FeatureNamespace,
                version: "1.0.0",
                description: "Invalid namespace",
            }),
        /namespace/,
    );
    assert.throws(
        () =>
            defineFeature({
                namespace: "symposium.invalid-version",
                version: "1.0" as FeatureVersion,
                description: "Invalid version",
            }),
        /version/,
    );
});

test("legacy API, AHP, and capability identifiers use canonical feature versions", () => {
    assert.equal(API_VERSION, API_FEATURE_VERSION);
    assert.equal(AHP_PROTOCOL_VERSION, AHP_FEATURE_VERSION);
    assert.equal(AHP_SUPPORTED_PROTOCOL_VERSIONS[0], AHP_FEATURE_VERSION);

    const capabilities = [
        [AHP_CAPABILITIES.changesets, CHANGESETS_FEATURE],
        [AHP_CAPABILITIES.clientTools, CLIENT_TOOLS_FEATURE],
        [AHP_CAPABILITIES.customizations, CUSTOMIZATIONS_FEATURE],
        [AHP_CAPABILITIES.resources, RESOURCES_FEATURE],
        [AHP_CAPABILITIES.telemetry, TELEMETRY_FEATURE],
        [AHP_CAPABILITIES.terminal, TERMINAL_FEATURE],
    ] as const;
    for (const [capability, feature] of capabilities) {
        assert.equal(capability, `${feature.namespace}.v${feature.version.split(".")[0]}`);
    }
});
