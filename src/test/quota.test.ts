import test from "node:test";
import assert from "node:assert/strict";
import { parseAdapterQuota } from "../adapters/quota";
import { CodexSession } from "../adapters/codex/session";
import { ClaudeSession } from "../adapters/claude/session";
import {
    canonicalClaudeWindowId,
    claudeUsageAuthMessage,
    parseClaudeApiUsage,
    parseClaudeQuota,
    staleClaudeUsage,
} from "../adapters/claude/usage";
import type { AgentEvent } from "../adapters/types";

test("normalizes Codex primary and secondary rate-limit windows from emitted JSON", () => {
    const quota = parseAdapterQuota(
        {
            type: "token_count",
            payload: {
                rate_limits: {
                    limit_id: "codex",
                    plan_type: "prolite",
                    primary: { used_percent: 77, window_minutes: 300, resets_at: 1_782_377_048 },
                    secondary: {
                        used_percent: 23,
                        window_minutes: 10_080,
                        resets_at: 1_782_963_848,
                    },
                },
            },
        },
        "codex",
    );

    assert.equal(quota?.backend, "codex");
    assert.equal(quota?.plan, "prolite");
    assert.deepEqual(quota?.windows, [
        { id: "primary", usedPercent: 77, windowMinutes: 300, resetsAt: 1_782_377_048_000 },
        { id: "secondary", usedPercent: 23, windowMinutes: 10_080, resetsAt: 1_782_963_848_000 },
    ]);
});

test("normalizes dynamic Claude aggregate windows and model-scoped entries", () => {
    const quota = parseAdapterQuota(
        {
            type: "usage",
            subscription_type: "pro",
            rate_limits: {
                five_hour: { utilization: 42, resets_at: "2026-07-22T19:00:00Z" },
                seven_day: { utilization: 18.5, resets_at: "2026-07-27T12:00:00Z" },
                model_scoped: [
                    { display_name: "Opus", utilization: 9, resets_at: "2026-07-27T12:00:00Z" },
                ],
            },
        },
        "claude",
    );

    assert.equal(quota?.plan, "pro");
    assert.deepEqual(
        quota?.windows.map(({ id, label, usedPercent }) => ({ id, label, usedPercent })),
        [
            { id: "five_hour", label: undefined, usedPercent: 42 },
            { id: "seven_day", label: undefined, usedPercent: 18.5 },
            { id: "model_scoped:Opus", label: "Opus", usedPercent: 9 },
        ],
    );
});

test("normalizes a Claude streaming rate_limit_event utilization fraction", () => {
    const quota = parseAdapterQuota(
        {
            type: "rate_limit_event",
            rate_limit_info: {
                status: "allowed_warning",
                rateLimitType: "five_hour",
                utilization: 0.81,
                resetsAt: 1_782_377_048,
            },
        },
        "claude",
    );

    assert.deepEqual(quota?.windows, [
        {
            id: "five_hour",
            usedPercent: 81,
            resetsAt: 1_782_377_048_000,
            status: "allowed_warning",
        },
    ]);
});

test("normalizes Claude Code synthetic session-limit errors with their zoned reset", () => {
    const quota = parseClaudeQuota({
        type: "assistant",
        timestamp: "2026-07-22T15:00:00.000Z",
        error: "rate_limit",
        apiErrorStatus: 429,
        isApiErrorMessage: true,
        message: {
            content: [
                {
                    type: "text",
                    text: "You've hit your session limit · resets 2:30pm (America/Sao_Paulo)",
                },
            ],
        },
    });

    assert.deepEqual(quota, {
        backend: "claude",
        limitName: "Limit reached",
        windows: [
            {
                id: "five_hour",
                usedPercent: 100,
                resetsAt: Date.parse("2026-07-22T17:30:00.000Z"),
                status: "blocked",
            },
        ],
        updatedAt: Date.parse("2026-07-22T15:00:00.000Z"),
    });
});

test("canonicalizes Claude account-window aliases without changing unknown ids", () => {
    assert.equal(canonicalClaudeWindowId("weekly_limit"), "seven_day");
    assert.equal(canonicalClaudeWindowId("Seven Day"), "seven_day");
    assert.equal(canonicalClaudeWindowId("session_limit"), "five_hour");
    assert.equal(canonicalClaudeWindowId("five_hour"), "five_hour");
    assert.equal(canonicalClaudeWindowId("newly_added_window"), "newly_added_window");
});

test("maps a Claude weekly hard limit onto the official seven-day window", () => {
    const quota = parseClaudeQuota({
        type: "result",
        is_error: true,
        result: "You've hit your weekly limit · resets 8:20pm (America/Sao_Paulo)",
    });

    assert.deepEqual(
        quota?.windows.map(({ id, label, usedPercent }) => ({ id, label, usedPercent })),
        [
            {
                id: "seven_day",
                label: undefined,
                usedPercent: 100,
            },
        ],
    );
});

test("does not duplicate unscoped weekly aliases but retains model-scoped limits", () => {
    const reset = "2026-07-26T22:59:59Z";
    const quota = parseClaudeApiUsage({
        seven_day: { utilization: 100, resets_at: reset },
        limits: [
            {
                kind: "weekly",
                group: "weekly",
                percent: 100,
                resets_at: reset,
                severity: "blocked",
            },
            {
                kind: "weekly_scoped",
                group: "weekly",
                percent: 100,
                resets_at: reset,
                scope: { model: { display_name: "Fable" } },
            },
        ],
    });

    assert.deepEqual(
        quota?.windows.map(({ id, label, usedPercent, status }) => ({
            id,
            label,
            usedPercent,
            status,
        })),
        [
            { id: "seven_day", label: undefined, usedPercent: 100, status: "blocked" },
            { id: "weekly_scoped:Fable", label: "Fable", usedPercent: 100, status: undefined },
        ],
    );
});

test("discovers Claude API usage windows and de-duplicates limit aliases", () => {
    const quota = parseClaudeApiUsage(
        {
            five_hour: { utilization: 100, resets_at: "2026-07-22T16:59:59Z" },
            seven_day: { utilization: 51, resets_at: "2026-07-26T22:59:59Z" },
            newly_added_window: { utilization: 12, resets_at: "2026-07-23T10:00:00Z" },
            limits: [
                {
                    kind: "session",
                    group: "session",
                    percent: 100,
                    resets_at: "2026-07-22T16:59:59Z",
                },
                {
                    kind: "weekly_scoped",
                    group: "weekly",
                    percent: 43,
                    resets_at: "2026-07-26T22:59:58Z",
                    scope: { model: { display_name: "Fable" } },
                    severity: "normal",
                },
            ],
        },
        { subscriptionType: "max" },
    );

    assert.equal(quota?.plan, "Max");
    assert.deepEqual(
        quota?.windows.map(({ id, label, usedPercent }) => ({ id, label, usedPercent })),
        [
            { id: "five_hour", label: undefined, usedPercent: 100 },
            { id: "seven_day", label: undefined, usedPercent: 51 },
            { id: "newly_added_window", label: undefined, usedPercent: 12 },
            { id: "weekly_scoped:Fable", label: "Fable", usedPercent: 43 },
        ],
    );
});

test("marks Claude fallback windows stale when live OAuth usage cannot refresh", () => {
    const stale = staleClaudeUsage(
        {
            backend: "claude",
            plan: "Max",
            windows: [
                { id: "seven_day", usedPercent: 76 },
                { id: "weekly_scoped:Fable", label: "Fable", usedPercent: 48 },
            ],
            updatedAt: 1,
            state: "ready",
        },
        "Claude",
        "Live Claude usage authentication expired or was revoked.",
    );

    assert.equal(stale.state, "stale");
    assert.equal(stale.displayName, "Claude");
    assert.equal(stale.message, "Live Claude usage authentication expired or was revoked.");
    assert.deepEqual(
        stale.windows.map((window) => window.id),
        ["seven_day", "weekly_scoped:Fable"],
    );
});

test("does not misreport unavailable Claude usage as a signed-out CLI", () => {
    assert.doesNotMatch(claudeUsageAuthMessage("missing-token"), /signed out/i);
    assert.doesNotMatch(claudeUsageAuthMessage("missing-token"), /auth login/i);
    assert.match(claudeUsageAuthMessage("missing-token"), /only affects account-usage display/i);
    assert.doesNotMatch(claudeUsageAuthMessage("rejected-token"), /auth login/i);
});

test("Claude limit parser accepts live result errors but not quoted user text", () => {
    const message = "You've hit your session limit · resets 8:20pm (America/Sao_Paulo)";
    assert.equal(
        parseClaudeQuota({ type: "result", is_error: true, result: message })?.windows[0]
            .usedPercent,
        100,
    );
    assert.equal(
        parseClaudeQuota({ type: "user", message: { content: [{ type: "text", text: message }] } }),
        undefined,
    );
});

test("ignores unrelated JSON and clamps malformed provider percentages", () => {
    assert.equal(
        parseAdapterQuota({ type: "assistant", message: { content: "rate_limits" } }, "claude"),
        undefined,
    );
    assert.equal(
        parseAdapterQuota({ rate_limits: { burst: { used_percentage: 150 } } }, "custom")
            ?.windows[0].usedPercent,
        100,
    );
});

test("Codex session forwards quota JSON as a normalized adapter event", () => {
    const session = new CodexSession(
        {
            executable: "codex",
            model: "",
            approvalPolicy: "admin",
            sandboxMode: "danger-full-access",
            reasoning: "default",
            workspaceDirs: [],
        },
        { cwd: process.cwd() },
    );
    const events: AgentEvent[] = [];
    session.on("event", (event: AgentEvent) => events.push(event));

    (session as unknown as { handleLine(line: string): void }).handleLine(
        JSON.stringify({
            type: "token_count",
            payload: { rate_limits: { primary: { used_percent: 64, window_minutes: 300 } } },
        }),
    );

    assert.equal(events[0]?.kind, "quota");
    assert.deepEqual(events[0]?.kind === "quota" ? events[0].windows : [], [
        { id: "primary", usedPercent: 64, windowMinutes: 300 },
    ]);
    session.dispose();
});

test("Claude session forwards rate_limit_event JSON as a normalized adapter event", () => {
    const session = new ClaudeSession(
        {
            executable: "claude",
            model: "",
            permissionMode: "plan",
            env: {},
        },
        { cwd: process.cwd() },
    );
    const events: AgentEvent[] = [];
    session.on("event", (event: AgentEvent) => events.push(event));

    (session as unknown as { handleLine(line: string): void }).handleLine(
        JSON.stringify({
            type: "rate_limit_event",
            rate_limit_info: { rateLimitType: "seven_day", utilization: 0.37, status: "allowed" },
        }),
    );

    assert.equal(events[0]?.kind, "quota");
    assert.deepEqual(events[0]?.kind === "quota" ? events[0].windows : [], [
        { id: "seven_day", usedPercent: 37, status: "allowed" },
    ]);
    session.dispose();
});

test("Claude session forwards a hard session limit as immediate quota state", () => {
    const session = new ClaudeSession(
        {
            executable: "claude",
            model: "",
            permissionMode: "plan",
            env: {},
        },
        { cwd: process.cwd() },
    );
    const events: AgentEvent[] = [];
    session.on("event", (event: AgentEvent) => events.push(event));

    (session as unknown as { handleLine(line: string): void }).handleLine(
        JSON.stringify({
            type: "result",
            is_error: true,
            timestamp: "2026-07-22T15:00:00.000Z",
            result: "You've hit your session limit · resets 8:20pm (America/Sao_Paulo)",
        }),
    );

    assert.equal(events[0]?.kind, "quota");
    assert.equal(events[0]?.kind === "quota" ? events[0].windows[0]?.usedPercent : undefined, 100);
    assert.deepEqual(events[1], {
        kind: "error",
        message: "You've hit your session limit · resets 8:20pm (America/Sao_Paulo)",
        retryable: true,
        retryAt: Date.parse("2026-07-22T23:20:00.000Z"),
        automaticRetry: false,
    });
    session.dispose();
});
