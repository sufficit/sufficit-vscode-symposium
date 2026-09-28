import assert from "node:assert/strict";
import test from "node:test";
import { GeniusEventParser } from "../adapters/genius/eventParser";
import type { AgentEvent } from "../adapters/types";

test("Genius native tasks synchronize confirmed snapshots without hiding tool history", () => {
    const events: AgentEvent[] = [];
    const parser = new GeniusEventParser({
        session: () => undefined,
        emit: (event) => events.push(event),
    });
    const frame = (actionType: string, action: object) =>
        JSON.stringify({ type: "event", schemaVersion: 1, actionType, action });
    const tool = (id: string, name: string, input: object, result: object | string) => {
        parser.handleLine(frame("chat/responsePart", { partId: id, kind: "ToolCall" }));
        parser.handleLine(
            frame("chat/delta", { partId: id, content: `${name}(${JSON.stringify(input)})` }),
        );
        parser.handleLine(
            frame("chat/delta", {
                partId: id,
                content: ` → ${typeof result === "string" ? result : JSON.stringify(result)}`,
            }),
        );
    };
    tool(
        "create",
        "tasks_create",
        { description: "Examinar imagem" },
        {
            id: "t1",
            status: "pending",
            description: "Examinar imagem",
        },
    );
    tool("failed", "tasks_create", { description: "Não criada" }, "invalid-arguments: rejected");
    tool(
        "update",
        "tasks_update",
        { id: "t1", status: "active" },
        {
            tasks: [{ id: "t1", status: "active", description: "Examinar imagem" }],
        },
    );
    tool(
        "list",
        "tasks_list",
        {},
        {
            tasks: [
                { id: "t1", status: "done", description: "Examinar imagem" },
                { id: "t2", status: "blocked", description: "Aguardar acesso" },
            ],
        },
    );
    tool("empty", "tasks_list", {}, { tasks: [] });

    const snapshots = events.filter(
        (event): event is Extract<AgentEvent, { kind: "tool-start" }> =>
            event.kind === "tool-start" && event.todos !== undefined,
    );
    assert.deepEqual(
        snapshots.map((event) => event.todos),
        [
            [{ content: "Examinar imagem", status: "pending", order: 1 }],
            [{ content: "Examinar imagem", status: "in_progress", order: 1 }],
            [
                { content: "Examinar imagem", status: "completed", order: 1 },
                { content: "Aguardar acesso", status: "pending", order: 2 },
            ],
            [],
        ],
    );
    assert.equal(events.filter((event) => event.kind === "tool-end").length, 9);
});
