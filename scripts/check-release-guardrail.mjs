#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync("package.json", "utf8"));
const lockfile = JSON.parse(readFileSync("package-lock.json", "utf8"));
const version = String(manifest.version || "");
const failures = [];
const versionMatch = /^(\d{4})\.([1-9]\d{2,3})\.(\d+)$/u.exec(version);

function git(args, allowFailure = false) {
    try {
        return execFileSync("git", args, { encoding: "utf8" }).trim();
    } catch (error) {
        if (allowFailure) return "";
        throw error;
    }
}

function gitSucceeds(args) {
    try {
        execFileSync("git", args, { stdio: "ignore" });
        return true;
    } catch {
        return false;
    }
}

function versionTuple(value) {
    const match = /^(\d{4})\.([1-9]\d{2,3})\.(\d+)$/u.exec(value);
    return match ? match.slice(1).map(Number) : undefined;
}

function compareVersions(left, right) {
    const a = versionTuple(left);
    const b = versionTuple(right);
    if (!a || !b) return undefined;
    for (let index = 0; index < a.length; index += 1) {
        if (a[index] !== b[index]) return a[index] - b[index];
    }
    return 0;
}

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
    const branch = git(["branch", "--show-current"]);
    if (branch && branch !== "develop") {
        failures.push(`release must be prepared from develop, not ${branch}`);
    } else if (!branch) {
        const head = git(["rev-parse", "HEAD"]);
        const develop = git(["rev-parse", "origin/develop"], true);
        if (!develop || !gitSucceeds(["merge-base", "--is-ancestor", head, develop])) {
            failures.push("detached release commit must already be published on origin/develop");
        }
    }
}

if (process.env.RELEASE_GUARDRAIL_REQUIRE_NEW_VERSION === "1" && versionMatch) {
    const latestTag = git(["tag", "--list", "v*", "--sort=-v:refname"]).split("\n")[0];
    const latestVersion = latestTag.startsWith("v") ? latestTag.slice(1) : "";
    if (latestVersion && compareVersions(version, latestVersion) <= 0) {
        failures.push(`version ${version} must be newer than the latest release ${latestVersion}`);
    }
}

const refType = process.env.GITHUB_REF_TYPE;
const refName = process.env.GITHUB_REF_NAME;
if (refType === "tag" && refName !== `v${version}`) {
    failures.push(`release tag ${refName} does not match package.json version v${version}`);
}

if (refType === "tag" && refName === `v${version}`) {
    if (git(["cat-file", "-t", `refs/tags/${refName}`], true) !== "tag") {
        failures.push(`release ${refName} must be an annotated tag`);
    }
    if (git(["rev-parse", `${refName}^{}`], true) !== git(["rev-parse", "HEAD"])) {
        failures.push(`release tag ${refName} must point to the checked-out commit`);
    }
}

if (failures.length) {
    console.error(`✗ release guardrail found ${failures.length} issue(s):`);
    for (const failure of failures) console.error(`  ${failure}`);
    process.exit(1);
}

console.log(`✓ release guardrail passed for v${version}`);
