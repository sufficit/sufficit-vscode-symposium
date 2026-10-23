// Behavior of scripts/check-markdown-coverage.mjs and the repository's own documentation hierarchy.
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { test } = require("node:test");

const ROOT = join(__dirname, "..");
const load = () => import(join(ROOT, "scripts", "check-markdown-coverage.mjs"));

test("markdown coverage: every repository document is in the hierarchy", async () => {
    const { check } = await load();
    assert.deepEqual(check(ROOT), []);
});

test("markdown coverage: reports orphans and disconnected cycles", async () => {
    const { MarkdownGraph } = await load();
    const graph = new MarkdownGraph({
        "README.md": "[Guide](guide.md)",
        "guide.md": "[Root](README.md)",
        "orphan.md": "[Self](orphan.md)",
        "cycle-a.md": "[B](cycle-b.md)",
        "cycle-b.md": "[A](cycle-a.md)",
    });
    assert.deepEqual(graph.unreachable(), ["cycle-a.md", "cycle-b.md", "orphan.md"]);
});

test("markdown coverage: follows relative, root, encoded, reference and HTML links", async () => {
    const { MarkdownGraph } = await load();
    const graph = new MarkdownGraph({
        "README.md": "[Guide](docs/) [Other][other]\n\n[other]: /OTHER.MD#section\n",
        "OTHER.MD": "",
        "docs/README.md": "[Details](./nested/../a%20b.md?view=1#section)",
        "docs/a b.md": '<p>See <a href="../end.md">End</a></p>\n',
        "end.md": "",
    });
    assert.deepEqual(graph.unreachable(), []);
});

test("markdown coverage: ignores code, images, comments and plain mentions", async () => {
    const { MarkdownGraph } = await load();
    const content =
        "plain.md\n`[Code](inline.md)`\n![Image](image.md)\n" +
        '<!-- [Hidden](comment.md) <a href="comment.md">Hidden</a> -->\n\n' +
        "```markdown\n[Example](fenced.md)\n```\n\n    [Indented](indented.md)\n\n" +
        '<pre><a href="pre.md">Example</a></pre>\n';
    const targets = [
        "comment.md",
        "fenced.md",
        "image.md",
        "indented.md",
        "inline.md",
        "plain.md",
        "pre.md",
    ];
    const documents = { "README.md": content };
    for (const target of targets) documents[target] = "";
    assert.deepEqual(new MarkdownGraph(documents).unreachable(), targets);
});

test("markdown coverage: ignores external links, anchors and paths outside the repository", async () => {
    const { MarkdownGraph } = await load();
    const graph = new MarkdownGraph({
        "README.md":
            "[Web](https://example.com/remote.md) [Relative web](//example.com/remote.md) " +
            "[Mail](mailto:remote.md) [File](file:///remote.md) [Anchor](#remote.md) " +
            "[Outside](../remote.md) [Encoded outside](%2E%2E/remote.md) [Script](script.mjs)",
        "remote.md": "",
    });
    assert.deepEqual(graph.unreachable(), ["remote.md"]);
    assert.deepEqual(graph.missingTargets(["README.md"]), {});
});

test("markdown coverage: reports missing targets only for requested sources", async () => {
    const { MarkdownGraph } = await load();
    const graph = new MarkdownGraph({
        "README.md": "[Index](docs/README.md)",
        "docs/README.md": "[Deleted](deleted.md) [Renamed](old%20name.md#intro)",
        "history.md": "[Old evidence](obsolete.md)",
    });
    assert.deepEqual(graph.missingTargets(["README.md", "docs/README.md"]), {
        "docs/README.md": ["docs/deleted.md", "docs/old name.md"],
    });
});

test("markdown coverage: ignore patterns match directories and single-segment globs", async () => {
    const { Exemptions, IGNORE_FILE } = await load();
    const root = mkdtempSync(join(tmpdir(), "md-coverage-"));
    try {
        writeFileSync(
            join(root, IGNORE_FILE),
            "# history\ndocs/activities/\n\n/AGENTS.md\nsrc/*/NOTES.md\n",
        );
        const exempt = Exemptions.load(root);
        assert.deepEqual(
            exempt.filter([
                "AGENTS.md",
                "docs/AGENTS.md",
                "docs/activities/2026-x.md",
                "docs/activitiesX.md",
                "src/api/NOTES.md",
                "src/api/deep/NOTES.md",
            ]),
            ["docs/AGENTS.md", "docs/activitiesX.md", "src/api/deep/NOTES.md"],
        );
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("markdown coverage: inventory uses tracked and new files, excluding ignored and deleted", async () => {
    const { MarkdownGraph } = await load();
    const root = mkdtempSync(join(tmpdir(), "md-coverage-git-"));
    const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
    try {
        git("init", "--quiet");
        writeFileSync(join(root, ".gitignore"), "ignored.md\n");
        writeFileSync(join(root, "README.md"), "[New](new.md)");
        writeFileSync(join(root, "deleted.md"), "");
        git("add", "README.md", "deleted.md");
        unlinkSync(join(root, "deleted.md"));
        for (const name of ["new.md", "ignored.md", "other.txt"])
            writeFileSync(join(root, name), "");
        mkdirSync(join(root, "empty"));
        const graph = MarkdownGraph.fromRepository(root);
        assert.deepEqual(graph.paths(), ["README.md", "new.md"]);
        assert.deepEqual(graph.unreachable(), []);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
