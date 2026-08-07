import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { JsonlAdapterUsage, parseQuotaJsonl } from "../adapters/quotaCache";

test("keeps Codex and Claude JSON readers isolated by adapter", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "symposium-quota-cache-"));
    try {
        const codexDir = path.join(home, ".codex", "sessions", "2026", "07", "22");
        const claudeDir = path.join(home, ".claude", "projects", "workspace");
        fs.mkdirSync(codexDir, { recursive: true });
        fs.mkdirSync(claudeDir, { recursive: true });
        fs.writeFileSync(
            path.join(codexDir, "rollout.jsonl"),
            [
                JSON.stringify({
                    timestamp: "2026-07-22T15:05:05.075Z",
                    type: "event_msg",
                    payload: {
                        type: "token_count",
                        rate_limits: {
                            plan_type: "prolite",
                            primary: {
                                used_percent: 15,
                                window_minutes: 10_080,
                                resets_at: 1_785_258_593,
                            },
                        },
                    },
                }),
                "{partially-written",
            ].join("\n"),
        );
        fs.writeFileSync(
            path.join(claudeDir, "session.jsonl"),
            [
                JSON.stringify({
                    timestamp: "2026-07-22T14:00:00Z",
                    type: "rate_limit_event",
                    rate_limit_info: {
                        rateLimitType: "five_hour",
                        utilization: 0.42,
                        resetsAt: 1_785_258_593,
                    },
                }),
                JSON.stringify({
                    timestamp: "2026-07-22T14:01:00Z",
                    type: "rate_limit_event",
                    rate_limit_info: {
                        rateLimitType: "seven_day",
                        utilization: 0.18,
                        resetsAt: 1_785_258_593,
                    },
                }),
            ].join("\n"),
        );

        const codexUsage = new JsonlAdapterUsage("codex", "Codex", () => [codexDir]);
        const claudeUsage = new JsonlAdapterUsage("claude", "Claude", () => [claudeDir]);
        const [codex, claude] = await Promise.all([codexUsage.read(true), claudeUsage.read(true)]);

        assert.equal(codex?.plan, "prolite");
        assert.equal(codex?.displayName, "Codex");
        assert.equal(codex?.state, "ready");
        assert.deepEqual(
            codex?.windows.map((window) => [window.usedPercent, window.windowMinutes]),
            [[15, 10_080]],
        );
        assert.deepEqual(
            claude?.windows.map((window) => [window.id, window.usedPercent]),
            [
                ["seven_day", 18],
                ["five_hour", 42],
            ],
        );
        assert.equal(claude?.displayName, "Claude");
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});

test("uses the provider timestamp from JSONL instead of making historical data look new", () => {
    const timestamp = "2026-07-20T10:30:00Z";
    const snapshots = parseQuotaJsonl(
        JSON.stringify({
            timestamp,
            rate_limits: { rolling: { used_percent: 31 } },
        }),
        "codex",
        1,
    );

    assert.equal(snapshots[0]?.updatedAt, Date.parse(timestamp));
});

test("discovers camelCase rateLimits JSON without provider-specific window names", () => {
    const snapshots = parseQuotaJsonl(
        JSON.stringify({
            timestamp: "2026-07-22T10:30:00Z",
            rateLimits: { rolling_window: { usedPercent: 27, windowMinutes: 90 } },
        }),
        "codex",
        1,
    );

    assert.deepEqual(snapshots[0]?.windows, [
        {
            id: "rolling_window",
            usedPercent: 27,
            windowMinutes: 90,
        },
    ]);
});
