import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNativeTodos, parseTodoFence, todosSummary } from "../adapters/todos";

test("parseNativeTodos: Claude TodoWrite", () => {
    const out = parseNativeTodos("TodoWrite", {
        todos: [{ content: "a", status: "completed" }, { content: "b", status: "in_progress" }, { content: "c" }],
    });
    assert.deepEqual(out, [
        { content: "a", status: "completed" },
        { content: "b", status: "in_progress" },
        { content: "c", status: "pending" },
    ]);
});

test("parseNativeTodos: Codex update_plan with steps + status spellings", () => {
    const out = parseNativeTodos("update_plan", { plan: [{ step: "x", status: "done" }, { step: "y", state: "doing" }] });
    assert.deepEqual(out, [{ content: "x", status: "completed" }, { content: "y", status: "in_progress" }]);
});

test("parseNativeTodos: Codex function_call update_plan arguments JSON", () => {
    const out = parseNativeTodos("function_call", {
        type: "function_call",
        name: "update_plan",
        arguments: JSON.stringify({
            plan: [
                { step: "Conferir branch", status: "completed" },
                { step: "Corrigir parser", status: "in_progress" },
                { step: "Validar", status: "pending" },
            ],
        }),
    });

    assert.deepEqual(out, [
        { content: "Conferir branch", status: "completed" },
        { content: "Corrigir parser", status: "in_progress" },
        { content: "Validar", status: "pending" },
    ]);
});

test("parseNativeTodos: Codex exec JSONL todo_list recovers completed and current states", () => {
    // Captured from codex-cli 0.144.1 `codex exec --json`: the public event
    // omits update_plan's status strings and exposes only a completed boolean.
    const out = parseNativeTodos("todo_list", {
        id: "item_0",
        type: "todo_list",
        items: [
            { text: "Inspect parser", completed: true },
            { text: "Report result", completed: false },
            { text: "Run regression", completed: false },
        ],
    });

    assert.deepEqual(out, [
        { content: "Inspect parser", status: "completed" },
        { content: "Report result", status: "in_progress" },
        { content: "Run regression", status: "pending" },
    ]);
});

test("parseNativeTodos: completed Codex todo_list leaves no current step", () => {
    const out = parseNativeTodos("todo_list", {
        items: [
            { text: "Inspect parser", completed: true },
            { text: "Report result", completed: true },
        ],
    });

    assert.deepEqual(out, [
        { content: "Inspect parser", status: "completed" },
        { content: "Report result", status: "completed" },
    ]);
    assert.equal(todosSummary(out!), undefined);
});

test("Codex todo_list reminder advances past completed work", () => {
    const out = parseNativeTodos("todo_list", {
        items: [
            { text: "Inspect parser", completed: true },
            { text: "Report result", completed: false },
            { text: "Run regression", completed: false },
        ],
    });
    const summary = todosSummary(out!);

    assert.match(summary!, /CURRENT: Report result/);
    assert.match(summary!, /- Run regression/);
    assert.doesNotMatch(summary!, /Inspect parser/);
});

test("parseNativeTodos: Codex custom_tool_call exec-sandboxed update_plan (real payload)", () => {
    // Captured verbatim from a real Codex CLI 0.144.1 rollout: the whole turn
    // is a JS "program" as source text (`input`), not a structured
    // function_call/arguments envelope — update_plan is one of several
    // `tools.*` calls inside it.
    const input = "const p = await tools.update_plan({plan:[\n" +
        "  {step:\"Consultar memórias Sufficit, instruções locais e estado Git do projeto\",status:\"in_progress\"},\n" +
        "  {step:\"Mapear arquitetura do backend, API, autenticação, dados e dependências\",status:\"pending\"},\n" +
        "  {step:\"Auditar segurança com evidências e validar riscos relevantes\",status:\"pending\"}\n" +
        "]});\n" +
        "const r = await tools.list_mcp_resources({});\n" +
        "const t = await tools.list_mcp_resource_templates({});\n" +
        "text(JSON.stringify({plan:p,resources:r,templates:t}));\n";
    const out = parseNativeTodos("custom_tool_call", {
        type: "custom_tool_call",
        id: "ctc_017abb2bd2dfe81b016a52ec102cf48191ba4c6752f5ee6c24",
        status: "completed",
        call_id: "call_ZMcpR9F6WzLPW7gPXqd00K5e",
        name: "exec",
        input,
    });
    assert.deepEqual(out, [
        { content: "Consultar memórias Sufficit, instruções locais e estado Git do projeto", status: "in_progress" },
        { content: "Mapear arquitetura do backend, API, autenticação, dados e dependências", status: "pending" },
        { content: "Auditar segurança com evidências e validar riscos relevantes", status: "pending" },
    ]);
});

test("parseNativeTodos: Codex exec update_plan, later call marks earlier steps completed", () => {
    const input = "const p = await tools.update_plan({plan:[" +
        "{step:\"a\",status:\"completed\"}," +
        "{step:\"b\",status:\"in_progress\"}," +
        "{step:\"c\",status:\"pending\"}" +
        "]});\n";
    const out = parseNativeTodos("custom_tool_call", { type: "custom_tool_call", name: "exec", input });
    assert.deepEqual(out, [
        { content: "a", status: "completed" },
        { content: "b", status: "in_progress" },
        { content: "c", status: "pending" },
    ]);
});

test("parseNativeTodos: exec call with no update_plan → undefined", () => {
    const input = "const r = await tools.exec_command({cmd:\"ls\",workdir:\"/tmp\"});\n";
    assert.equal(parseNativeTodos("custom_tool_call", { type: "custom_tool_call", name: "exec", input }), undefined);
});

test("parseNativeTodos: non-todo tool → undefined", () => {
    assert.equal(parseNativeTodos("Edit", { file_path: "/a" }), undefined);
});

test("parseTodoFence: checkbox block", () => {
    const md = "before\n```todo\n- [x] done\n- [-] doing\n- [ ] todo\n```\nafter";
    assert.deepEqual(parseTodoFence(md), [
        { content: "done", status: "completed" },
        { content: "doing", status: "in_progress" },
        { content: "todo", status: "pending" },
    ]);
});

test("parseTodoFence: no block → undefined", () => {
    assert.equal(parseTodoFence("just text"), undefined);
});


test("parseTodoFence: ordered checkbox block keeps order numbers", () => {
    const md = "```todo\n1. [ ] first\n2. [-] second\n3. [x] third\n```";
    assert.deepEqual(parseTodoFence(md), [
        { content: "first", status: "pending", order: 1 },
        { content: "second", status: "in_progress", order: 2 },
        { content: "third", status: "completed", order: 3 },
    ]);
});
