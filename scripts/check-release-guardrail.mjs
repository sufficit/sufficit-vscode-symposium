#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync("package.json", "utf8"));
const lockfile = JSON.parse(readFileSync("package-lock.json", "utf8"));
const version = String(manifest.version || "");
const failures = [];
const versionMatch = /^(\d{4})\.([1-9]\d{2,3})\.(\d+)$/u.exec(version);

if (!versionMatch) {
    failures.push(`package.json version is not YYYY.MMDD.X without leading zeros: ${version}`);
}

if (lockfile.version !== version || lockfile.packages?.[""].version !== version) {
    failures.push("package-lock.json is not synchronized with package.json");
}

if (versionMatch) {
    const expectedFormat = `${versionMatch[1]}.${versionMatch[2]}.X`;
    const versionDocument = readFileSync("VERSION.md", "utf8");
    if (!versionDocument.includes(`Correct Version Format: ${expectedFormat}`)) {
        failures.push(`VERSION.md must declare: Correct Version Format: ${expectedFormat}`);
    }
}

if (process.env.RELEASE_GUARDRAIL_REQUIRE_DEVELOP === "1") {
    const branch = execFileSync("git", ["branch", "--show-current"], { encoding: "utf8" }).trim();
    if (branch !== "develop") {
        failures.push(`release must be prepared from develop, not ${branch || "detached HEAD"}`);
    }
}

const refType = process.env.GITHUB_REF_TYPE;
const refName = process.env.GITHUB_REF_NAME;
if (refType === "tag" && refName !== `v${version}`) {
    failures.push(`release tag ${refName} does not match package.json version v${version}`);
}

if (failures.length) {
    console.error(`✗ release guardrail found ${failures.length} issue(s):`);
    for (const failure of failures) console.error(`  ${failure}`);
    process.exit(1);
}

console.log(`✓ release guardrail passed for v${version}`);
