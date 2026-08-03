import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { mergeQuotaSnapshot } from "../ui/quotaSnapshot";

const statusbar = readFileSync(resolve(__dirname, "../../src/ui/webview/statusbar.ts"), "utf8");
const events = readFileSync(resolve(__dirname, "../../src/ui/webview/events.ts"), "utf8");
const css = readFileSync(resolve(__dirname, "../../src/ui/webview/chat.css"), "utf8");
const surface = readFileSync(resolve(__dirname, "../../src/ui/chatSurface.ts"), "utf8");
const surfaceContext = readFileSync(resolve(__dirname, "../../src/ui/chatSurfaceContext.ts"), "utf8");
const dialogues = readFileSync(resolve(__dirname, "../../src/ui/surfaceDialogues.ts"), "utf8");
const dialogueTypes = readFileSync(resolve(__dirname, "../../src/ui/surfaceDialoguesTypes.ts"), "utf8");

test("quota badge is available by pointer, keyboard focus, and click", () => {
    assert.match(statusbar, /addEventListener\("mouseenter"/);
    assert.match(statusbar, /addEventListener\("focus"/);
    assert.match(statusbar, /addEventListener\("click"/);
    assert.match(statusbar, /aria-haspopup/);
    assert.match(css, /\.tokenMeter:focus-visible/);
});

test("context overflow remains numerically visible and never shows negative free space", () => {
    assert.match(statusbar, /displayedPercent/);
    assert.match(statusbar, /Context window exceeded:/);
    assert.match(statusbar, /contextExceeded/);
    assert.match(statusbar, /const freePct = Math\.max\(0, 100 - pct\)/);
    assert.match(statusbar, /fill\.style\.width = Math\.min\(100, pct\)/);
    assert.match(statusbar, /Over the reported context limit/);
    assert.match(css, /\.contextMeter\.contextExceeded/);
});

test("stale Claude quota replaces ghost windows and explains the failed refresh", () => {
    assert.match(statusbar, /quota\.state === "stale"/);
    assert.match(statusbar, /Cached adapter data/);
    assert.match(statusbar, /mergeQuotaSnapshot/);
    assert.match(css, /\.quotaPop \.qWarning/);
});

test("ready Claude quota clears a stale authentication message and limit label", () => {
    const current = mergeQuotaSnapshot({
        backend: "claude",
        displayName: "Claude",
        plan: "Max",
        limitName: "Limit reached",
        windows: [{ id: "five_hour", usedPercent: 0 }],
        updatedAt: 1,
        state: "stale",
        message: "Live Claude usage is unavailable because Claude Code is signed out.",
    }, {
        backend: "claude",
        displayName: "Claude",
        plan: "Max",
        windows: [
            { id: "five_hour", usedPercent: 21 },
            { id: "seven_day", usedPercent: 2 },
        ],
        updatedAt: 2,
        state: "ready",
    });

    assert.equal(current.state, "ready");
    assert.equal("message" in current, false);
    assert.equal("limitName" in current, false);
    assert.deepEqual(current.windows.map(({ id, usedPercent }) => ({ id, usedPercent })), [
        { id: "five_hour", usedPercent: 21 },
        { id: "seven_day", usedPercent: 2 },
    ]);
});

test("quota panel renders semantic dynamic progress bars", () => {
    assert.match(events, /ev\.kind === "quota"/);
    assert.match(statusbar, /setAttribute\("role", "progressbar"\)/);
    assert.match(statusbar, /quota\.windows/);
    assert.match(statusbar, /% available/);
    assert.match(statusbar, /window\.detail/);
    assert.doesNotMatch(statusbar, /"(?:five_hour|seven_day|primary|secondary)"/);
});

test("preset health stays aggregate and never renders provider quota rows", () => {
    assert.match(statusbar, /snapshot\.healthPercent/);
    assert.match(statusbar, /Preset health/);
    assert.match(statusbar, /health != null \? 100 - health/);
    assert.match(statusbar, /if \(health == null\)/);
    assert.match(statusbar, /Sufficit preset health/);
});

test("quota badge renders only the current conversation adapter", () => {
    assert.match(statusbar, /function currentQuotaSnapshot/);
    assert.match(statusbar, /quotaByBackend\.get\(current\)/);
    assert.doesNotMatch(statusbar, /const quotaProviders/);
    assert.doesNotMatch(statusbar, /snapshots\[0\]/);
    assert.match(statusbar, /statusbar\.appendChild\(quotaMeter\)/);
    assert.match(statusbar, /This adapter has not reported usage limits yet/);
    assert.match(statusbar, /type: "refresh-quotas"/);
    assert.match(statusbar, /quotaPopoverOpen/);
    assert.match(css, /\.quotaMeter\.quotaEmpty/);
});

test("chat surface asks only the active adapter usage singleton", () => {
    assert.doesNotMatch(surface, /loadCachedAdapterQuotas/);
    assert.match(surface, /const usage = this\.activeUsage/);
    assert.match(surface, /const snapshot = await usage\.read\(force, \{ model \}\)/);
    assert.match(surface, /presetQuotaLoadingEvent\(usage\)/);
    assert.match(surfaceContext, /Reading usage for the selected preset/);
    assert.match(surface, /generation !== this\.quotaGeneration/);
    assert.match(surface, /setInterval\(\(\) => void this\.refreshQuotas\(\), 60_000\)/);
    assert.match(surface, /type: "quota-loading"/);
    assert.match(dialogueTypes, /activateUsage: \(adapter: AgentAdapter\)/);
    assert.equal((dialogues.match(/this\.d\.activateUsage\(adapter\)/g) || []).length, 3);
});

test("quota animation respects reduced-motion preferences", () => {
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
    assert.match(css, /\.quotaPop \.qFill \{ transition: none; \}/);
    assert.match(css, /\.quotaMeter\[aria-busy="true"\] \.tmRing \{ animation: none; \}/);
});
