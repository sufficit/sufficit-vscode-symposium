import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
    loadMarkdownImage,
    resolveLocalFileTarget,
    resolveLocalResourcePath,
} from "../ui/markdownImages";
import {
    inlineTokenRegex,
    isExternalMarkdownLink,
    isLocalMarkdownTarget,
    parseMarkdownLinkToken,
} from "../ui/webview/markdownTokens";

test("Markdown tokens preserve image syntax and relative link destinations", () => {
    const source =
        "![Arte do changelog](public/images/hermes.png) [ABRIR IMAGEM](public/images/hermes.png)";
    const tokens = [...source.matchAll(inlineTokenRegex())].map((match) =>
        parseMarkdownLinkToken(match[0]),
    );
    assert.deepEqual(tokens, [
        { image: true, label: "Arte do changelog", href: "public/images/hermes.png" },
        { image: false, label: "ABRIR IMAGEM", href: "public/images/hermes.png" },
    ]);
    assert.equal(isLocalMarkdownTarget("public/images/hermes.png"), true);
    assert.equal(isExternalMarkdownLink("https://example.com/image.png"), true);
});

test("webview and host wire local Markdown image resolution end to end", () => {
    const markdown = readFileSync(
        path.resolve(__dirname, "../../src/ui/webview/markdown.ts"),
        "utf8",
    );
    const dispatch = readFileSync(
        path.resolve(__dirname, "../../src/ui/webview/dispatch.ts"),
        "utf8",
    );
    const surface = readFileSync(
        path.resolve(__dirname, "../../src/ui/surfaceMessages.ts"),
        "utf8",
    );
    assert.match(markdown, /type: "resolve-markdown-image", id, path: href/);
    assert.match(markdown, /type: "open-file", path: href/);
    assert.match(dispatch, /case "markdown-image"/);
    assert.match(surface, /case "resolve-markdown-image"/);
});

test("resolveLocalResourcePath handles relative paths and encoded file URIs", () => {
    assert.equal(
        resolveLocalResourcePath("images/a.png", "/work/project"),
        path.resolve("/work/project/images/a.png"),
    );
    const local = path.join(os.tmpdir(), "image with spaces.png");
    assert.equal(resolveLocalResourcePath(pathToFileURL(local).href), local);
    assert.equal(resolveLocalResourcePath("https://example.com/a.png", "/work/project"), undefined);
});

test("resolveLocalFileTarget separates source locations from absolute and relative paths", () => {
    assert.deepEqual(resolveLocalFileTarget("/work/project/src/main.ts:12:4", "/ignored"), {
        fsPath: path.normalize("/work/project/src/main.ts"),
        line: 12,
        column: 4,
    });
    assert.deepEqual(resolveLocalFileTarget("src/main.ts#L7C2", "/work/project"), {
        fsPath: path.resolve("/work/project/src/main.ts"),
        line: 7,
        column: 2,
    });
    assert.deepEqual(
        resolveLocalFileTarget(pathToFileURL("/work/project/src/main.ts").href + ":3"),
        { fsPath: path.normalize("/work/project/src/main.ts"), line: 3, column: undefined },
    );
});

test("resolveLocalFileTarget resolves a workspace-qualified path across multi-root workspaces", () => {
    assert.deepEqual(
        resolveLocalFileTarget(
            "sufficit-base/src/Contacts/Address.cs:9",
            "/mnt/workspaces/sufficit",
            ["/mnt/workspaces/sufficit", "/mnt/sufficit/sufficit-base"],
        ),
        {
            fsPath: path.normalize("/mnt/sufficit/sufficit-base/src/Contacts/Address.cs"),
            line: 9,
            column: undefined,
        },
    );
});

test("loadMarkdownImage reads allowed images and blocks traversal outside roots", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "symposium-md-image-"));
    const root = path.join(base, "workspace");
    const inside = path.join(root, "public", "image.png");
    const outside = path.join(base, "secret.png");
    await mkdir(path.dirname(inside), { recursive: true });
    await writeFile(inside, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(outside, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    try {
        const result = await loadMarkdownImage("public/image.png", root, [root]);
        assert.equal(result.dataUrl, "data:image/png;base64,iVBORw==");
        assert.equal(result.error, undefined);
        assert.match(
            (await loadMarkdownImage(outside, root, [root])).error ?? "",
            /outside the active workspace/,
        );
    } finally {
        await rm(base, { recursive: true, force: true });
    }
});
