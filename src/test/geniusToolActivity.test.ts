import assert from "node:assert/strict";
import test from "node:test";
import { GeniusEventParser } from "../adapters/genius/eventParser";
import type { AgentEvent } from "../adapters/types";

function toolStart(
    name: string,
    argumentsJson: string,
): Extract<AgentEvent, { kind: "tool-start" }> {
    const events: AgentEvent[] = [];
    const parser = new GeniusEventParser({
        session: () => undefined,
        emit: (event) => events.push(event),
    });
    parser.handleLine(
        JSON.stringify({
            type: "event",
            schemaVersion: 1,
            actionType: "chat/responsePart",
            action: { partId: "tool-1", kind: "ToolCall" },
        }),
    );
    parser.handleLine(
        JSON.stringify({
            type: "event",
            schemaVersion: 1,
            actionType: "chat/delta",
            action: { partId: "tool-1", content: `${name}(${argumentsJson})` },
        }),
    );
    const started = events.find((event) => event.kind === "tool-start");
    assert.ok(started);
    assert.equal(started.kind, "tool-start");
    return started;
}

test("Genius catalog rows describe search, browse, and activation", () => {
    assert.equal(
        toolStart("catalog", '{"action":"search","query":"document OCR"}').detail,
        "Search tools: document OCR",
    );
    assert.equal(toolStart("catalog", '{"action":"categories"}').detail, "Browse tool categories");
    assert.equal(
        toolStart("catalog", '{"action":"activate","names":["shell_exec","workspace_read"]}')
            .detail,
        "Activate shell_exec, workspace_read",
    );
});

test("Genius tool intent takes precedence while complete arguments remain expandable", () => {
    const input = '{"command":"git status --short","intent":"Check repository changes"}';
    const event = toolStart("shell_exec", input);
    assert.equal(event.detail, "Check repository changes");
    assert.equal(event.input, input);
    assert.equal(
        toolStart("shell_exec", '{"command":"git status --short"}').detail,
        "git status --short",
    );
    assert.equal(toolStart("shell_exec", '{"command":"rg pattern src | head"}').detail, "Run rg");
});

test("Genius OCR and generic tools identify a safe target", () => {
    assert.equal(
        toolStart("mcp__sufficit_ai__document_ocr", '{"file_path":"/tmp/invoice.pdf"}').detail,
        "invoice.pdf",
    );
    assert.equal(toolStart("workspace_read", '{"path":"/tmp/notes.md"}').detail, "notes.md");
});

test("Genius action summaries do not expose secret arguments or malformed payloads", () => {
    assert.equal(
        toolStart(
            "shell_exec",
            '{"command":"curl -H Authorization:Bearer-private https://example.com"}',
        ).detail,
        "Run shell command",
    );
    assert.equal(toolStart("catalog", '{"query":"api_key=private"}').detail, "Search tools");
    assert.equal(toolStart("shell_exec", "{bad json").detail, "Run shell command");
});
