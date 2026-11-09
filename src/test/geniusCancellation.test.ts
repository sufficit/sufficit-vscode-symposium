import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { GeniusAdapter } from "../adapters/genius/adapter";
import assert from "node:assert/strict";
import test from "node:test";
import { GeniusEventParser } from "../adapters/genius/eventParser";
import type { AgentEvent } from "../adapters/types";
import { presentTurnError } from "../ui/errorPresentation";

for (const reason of ["service_stopping", "user_cancelled", "timeout"]) {
    test(`Genius preserves ${reason} without automatic retry or replay`, () => {
        const events: AgentEvent[] = [];
        const parser = new GeniusEventParser({ session() {}, emit: (e) => events.push(e) });
        parser.handleLine(
            JSON.stringify({
                schemaVersion: 1,
                type: "error",
                status: "cancelled",
                error: "Genius command cancelled",
                data: { code: reason, cancellationReason: reason },
            }),
        );
        const error = events.find((e) => e.kind === "error");
        assert.ok(error?.kind === "error");
        assert.ok("cancellationReason" in error);
        assert.equal(error.cancellationReason, reason);
        assert.equal(error.retryable, false);
        assert.equal(error.automaticRetry, false);
        const ui = presentTurnError(error.message, error.retryable);
        assert.doesNotMatch(ui.summary, /update the request or configuration/i);
        if (reason === "service_stopping") {
            assert.match(ui.summary, /service.*stopp|service.*restart/i);
            assert.ok("recovery" in ui);
            assert.equal(ui.recovery, "continue");
        }
        if (reason === "user_cancelled") assert.match(ui.summary, /cancelled by the user/i);
        if (reason === "timeout") assert.match(ui.summary, /timed out/i);
    });
}

test("legacy Genius cancellation does not invent a user action or enable Retry", () => {
    const ui = presentTurnError("Genius command cancelled", false);
    assert.match(ui.summary, /reason.*not.*reported|source.*not.*reported/i);
    assert.doesNotMatch(ui.summary, /cancelled by the user|update the request or configuration/i);
});

test("manual Continue uses the native session and prior instructions without replaying the request", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "genius-continue-"));
    const trace = path.join(root, "trace.jsonl");
    const id = "11111111-2222-4333-8444-555555555555";
    const adapter = new GeniusAdapter(() => ({
        executable: path.resolve(__dirname, "../../test/fixtures/fake-genius-cli.cjs"),
        model: "",
        env: { FAKE_GENIUS_TRACE: trace },
        tokenProvider: () => Promise.resolve(null),
    }));
    const session = adapter.start({ cwd: root, resumeSessionId: id });
    const ended = () =>
        new Promise<void>((resolve) => {
            const onEvent = (e: AgentEvent) => {
                if (e.kind === "turn-end") {
                    session.off("event", onEvent);
                    resolve();
                }
            };
            session.on("event", onEvent);
        });
    try {
        const first = ended();
        session.send("original request that must never be replayed", undefined, [
            "host instructions",
        ]);
        await first;
        assert.ok(session.continueTurn);
        const second = ended();
        session.continueTurn();
        await second;
        const calls = fs
            .readFileSync(trace, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
        assert.equal(calls.length, 2);
        assert.match(calls[1].prompt, /^Continue from the saved progress/);
        assert.doesNotMatch(calls[1].prompt, /original request that must never be replayed/);
        assert.deepEqual(calls[1].instructions, ["host instructions"]);
        assert.ok(calls[1].args.includes("--resume"));
        assert.ok(calls[1].args.includes(id));
    } finally {
        session.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

for (const reason of ["user_cancelled", "timeout", "cancelled_unknown"]) {
    test(`native failed result preserves ${reason} instead of becoming a generic terminal error`, () => {
        const events: AgentEvent[] = [];
        const parser = new GeniusEventParser({ session() {}, emit: (event) => events.push(event) });
        parser.handleLine(
            JSON.stringify({
                schemaVersion: 1,
                type: "result",
                status: "failed",
                error: "Native turn interrupted",
                cancellationReason: reason,
            }),
        );
        const event = events.find((value) => value.kind === "error");
        assert.ok(event?.kind === "error");
        assert.ok("cancellationReason" in event);
        assert.equal(event.cancellationReason, reason);
        assert.equal(event.retryable, false);
        assert.equal(event.automaticRetry, false);
        assert.equal(parser.sawResult, true);
        assert.equal(parser.sawError, true);
    });
}

test("legacy cancellation frame becomes unknown without guessing who stopped it", () => {
    const events: AgentEvent[] = [];
    const parser = new GeniusEventParser({ session() {}, emit: (event) => events.push(event) });
    parser.handleLine(
        JSON.stringify({ schemaVersion: 1, type: "error", error: "Genius command cancelled" }),
    );
    const event = events[0];
    assert.ok(event.kind === "error");
    assert.ok("cancellationReason" in event);
    assert.equal(event.cancellationReason, "cancelled_unknown");
    assert.match(presentTurnError(event.message).summary, /source was not reported/);
});
