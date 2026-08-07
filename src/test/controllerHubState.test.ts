import { test } from "node:test";
import assert from "node:assert/strict";
import { pendingTasksSummary, HubStateContext, HubState } from "../application/controllerHubState";
import { TaskItem } from "../sync/tasks";

// --- Regressão entrega 0C (Hub tasks): o reminder é CONTEXTO, não override ---
// Paralelo ao teste do todosSummary: o reminder de tasks do Hub também era
// injetado como `developer` em toda mensagem e podia comandar retomada de
// backlog antigo. Agora declara-se subordinado à última mensagem do usuário.

const anchor = (overrides: Partial<TaskItem> = {}): TaskItem => ({
    id: "t1",
    type: "task-anchor",
    title: "Implementar rescan",
    summary: "rescan",
    tags: "",
    done: false,
    ...overrides,
});

function ctxWith(state: HubState): HubStateContext {
    return {
        sessionId: () => "s1",
        hub: () =>
            ({ configured: () => true }) as unknown as HubStateContext["hub"] extends () => infer H
                ? H
                : never,
        state,
    } as unknown as HubStateContext;
}

test("pendingTasksSummary declares itself CONTEXT subordinate to the latest user message", () => {
    const state: HubState = { guardrails: [], guardrailsLoaded: false, pendingTasks: [anchor()] };
    const summary = pendingTasksSummary(ctxWith(state));
    assert.ok(summary);
    assert.match(summary!, /CONTEXT, not an override/i);
    assert.match(summary!, /LATEST USER MESSAGE is the source of truth/i);
    assert.match(summary!, /YIELD/i);
    assert.match(summary!, /only document/i);
    // And it still surfaces the CURRENT task so it remains useful as context.
    assert.match(summary!, /CURRENT \(id=t1\): Implementar rescan/);
});

test("pendingTasksSummary yields on redirect signals — reminder text does not assert 'resume exactly'", () => {
    const state: HubState = { guardrails: [], guardrailsLoaded: false, pendingTasks: [anchor()] };
    const summary = pendingTasksSummary(ctxWith(state));
    assert.ok(summary);
    // The reminder must never command unconditional resumption of the backlog.
    assert.doesNotMatch(summary!, /resume exactly/i);
    assert.doesNotMatch(summary!, /you must (continue|resume)/i);
});

test("pendingTasksSummary returns undefined when there are no pending work items", () => {
    const state: HubState = { guardrails: [], guardrailsLoaded: false, pendingTasks: [] };
    assert.equal(pendingTasksSummary(ctxWith(state)), undefined);
});
