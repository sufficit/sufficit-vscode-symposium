import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { mergeQuotaSnapshot, resolveStatusbarData } from "../ui/quotaSnapshot";

const statusbar = readFileSync(resolve(__dirname, "../../src/ui/webview/statusbar.ts"), "utf8");
const usagePopover = readFileSync(
    resolve(__dirname, "../../src/ui/webview/statusbarUsagePopover.ts"),
    "utf8",
);
const quotaPopover = readFileSync(
    resolve(__dirname, "../../src/ui/webview/statusbarQuotaPopover.ts"),
    "utf8",
);
const events = readFileSync(resolve(__dirname, "../../src/ui/webview/events.ts"), "utf8");
const css = readFileSync(resolve(__dirname, "../../src/ui/webview/chat.css"), "utf8");
const surface = readFileSync(resolve(__dirname, "../../src/ui/chatSurface.ts"), "utf8");
const surfaceQuota = readFileSync(resolve(__dirname, "../../src/ui/surfaceQuota.ts"), "utf8");
const surfaceContext = readFileSync(
    resolve(__dirname, "../../src/ui/chatSurfaceContext.ts"),
    "utf8",
);
const dialogues = readFileSync(resolve(__dirname, "../../src/ui/surfaceDialogues.ts"), "utf8");
const dialogueTypes = readFileSync(
    resolve(__dirname, "../../src/ui/surfaceDialoguesTypes.ts"),
    "utf8",
);

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
    assert.match(usagePopover, /const freePct = Math\.max\(0, 100 - pct\)/);
    assert.match(usagePopover, /fill\.style\.width = Math\.min\(100, pct\)/);
    assert.match(usagePopover, /Over the reported context limit/);
    assert.match(css, /\.contextMeter\.contextExceeded/);
});

test("stale Claude quota replaces ghost windows and explains the failed refresh", () => {
    assert.match(quotaPopover, /quota\.state === "stale"/);
    assert.match(quotaPopover, /Cached adapter data/);
    assert.match(statusbar, /mergeQuotaSnapshot/);
    assert.match(css, /\.quotaPop \.qWarning/);
});

test("ready Claude quota clears a stale authentication message and limit label", () => {
    const current = mergeQuotaSnapshot(
        {
            backend: "claude",
            displayName: "Claude",
            plan: "Max",
            limitName: "Limit reached",
            windows: [{ id: "five_hour", usedPercent: 0 }],
            updatedAt: 1,
            state: "stale",
            message: "Live Claude usage is unavailable because Claude Code is signed out.",
        },
        {
            backend: "claude",
            displayName: "Claude",
            plan: "Max",
            windows: [
                { id: "five_hour", usedPercent: 21 },
                { id: "seven_day", usedPercent: 2 },
            ],
            updatedAt: 2,
            state: "ready",
        },
    );

    assert.equal(current.state, "ready");
    assert.equal("message" in current, false);
    assert.equal("limitName" in current, false);
    assert.deepEqual(
        current.windows.map(({ id, usedPercent }) => ({ id, usedPercent })),
        [
            { id: "five_hour", usedPercent: 21 },
            { id: "seven_day", usedPercent: 2 },
        ],
    );
});

test("an unavailable refresh preserves the last live limits as stale", () => {
    const current = mergeQuotaSnapshot(
        {
            backend: "codex",
            displayName: "Codex",
            plan: "pro",
            windows: [{ id: "primary", usedPercent: 17, windowMinutes: 10_080 }],
            updatedAt: 10,
        },
        {
            backend: "codex",
            displayName: "Codex",
            windows: [],
            updatedAt: 20,
            state: "unavailable",
            message: "No recent limits were found.",
        },
    );

    assert.equal(current.state, "stale");
    assert.equal(current.updatedAt, 10);
    assert.equal(current.message, "No recent limits were found.");
    assert.deepEqual(current.windows, [{ id: "primary", usedPercent: 17, windowMinutes: 10_080 }]);
});

test("quota panel renders semantic dynamic progress bars", () => {
    assert.match(events, /ev\.kind === "quota"/);
    assert.match(quotaPopover, /setAttribute\("role", "progressbar"\)/);
    assert.match(quotaPopover, /quota\.windows/);
    assert.match(quotaPopover, /% available/);
    assert.match(quotaPopover, /window\.detail/);
    assert.doesNotMatch(quotaPopover, /"(?:five_hour|seven_day|primary|secondary)"/);
});

test("preset health stays aggregate and never renders provider quota rows", () => {
    assert.match(statusbar, /snapshot\.healthPercent/);
    assert.match(statusbar, /Preset health/);
    assert.match(statusbar, /health != null \? 100 - health/);
    assert.match(quotaPopover, /if \(health == null\)/);
    assert.match(quotaPopover, /Sufficit preset health/);
});

test("quota badge renders only the current conversation adapter", () => {
    assert.match(statusbar, /function currentQuotaSnapshot/);
    assert.match(statusbar, /quotaByBackend\.get\(current\)/);
    assert.doesNotMatch(statusbar, /const quotaProviders/);
    assert.doesNotMatch(statusbar, /snapshots\[0\]/);
    assert.match(statusbar, /statusbar\.appendChild\(quotaMeter\)/);
    assert.match(quotaPopover, /This adapter has not reported usage limits yet/);
    assert.match(quotaPopover, /type: "refresh-quotas"/);
    assert.match(statusbar, /quotaPopoverOpen/);
    assert.match(css, /\.quotaMeter\.quotaEmpty/);
});

test("quota redraw preserves the active backend instead of looking up an empty key", () => {
    const codex = { backend: "codex", backendName: "Codex", cwd: "/workspace" };
    assert.strictEqual(resolveStatusbarData(codex, {}), codex);
    assert.strictEqual(resolveStatusbarData(codex), codex);
    assert.deepEqual(resolveStatusbarData(codex, { backend: "claude", backendName: "Claude" }), {
        backend: "claude",
        backendName: "Claude",
    });
    assert.match(statusbar, /resolveStatusbarData\(lastStatusData, data\)/);
});

test("chat surface asks only the active adapter usage singleton", () => {
    assert.doesNotMatch(surface, /loadCachedAdapterQuotas/);
    assert.match(surfaceQuota, /const usage = this\.usage/);
    assert.match(surfaceQuota, /const snapshot = await withAbortableDeadline/);
    assert.match(surfaceQuota, /\(\) => usage\.read\(force, \{ model \}\)/);
    assert.match(surfaceQuota, /presetQuotaLoadingEvent\(usage\)/);
    assert.match(surfaceContext, /Reading usage for the selected preset/);
    assert.match(surfaceQuota, /generation === this\.generation/);
    assert.match(surfaceQuota, /setInterval\(\(\) => void this\.refresh\(\), 60_000\)/);
    assert.match(surfaceQuota, /type: "quota-loading"/);
    assert.match(dialogueTypes, /activateUsage: \(adapter: AgentAdapter\)/);
    assert.equal((dialogues.match(/this\.d\.activateUsage\(adapter\)/g) || []).length, 2);
});

test("quota animation respects reduced-motion preferences", () => {
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
    assert.match(css, /\.quotaPop \.qFill \{ transition: none; \}/);
    assert.match(css, /\.quotaMeter\[aria-busy="true"\] \.tmRing \{ animation: none; \}/);
});
