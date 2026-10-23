#!/usr/bin/env node
// Checks that every Markdown file is part of the documentation hierarchy:
// - every Markdown file is reachable from README.md through relative links;
// - maintained documents do not link to Markdown files that do not exist.
//
// Paths matched by .markdown-coverage-ignore ("dir/" prefixes or glob patterns
// where "*" stays within one path segment) are exempt from both rules; links
// pointing INTO them are still validated.
//
// Links follow CommonMark semantics: inline, reference-style and HTML anchors
// count; code spans and blocks, images, comments and external links do not.
// A directory link counts when the directory has a README.md.
//
// Usage: node scripts/check-markdown-coverage.mjs   (exit status 1 on violations)

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";
import MarkdownIt from "markdown-it";

export const ENTRYPOINT = "README.md";
export const IGNORE_FILE = ".markdown-coverage-ignore";

const EXTERNAL = /^(?:[a-z][a-z\d+.-]*:|\/\/|[?#])/i;
const COMMENT = /<!--[\s\S]*?-->/g;
const PRE = /<(pre|code)\b[\s\S]*?<\/\1>/gi;
const ANCHOR_HREF = /<a\s[^>]*?href\s*=\s*["']([^"']*)["']/gi;
const parser = new MarkdownIt("commonmark");

/** Link destinations a CommonMark renderer would produce, excluding images and code. */
export function destinations(content) {
    const hrefs = [];
    const html = [];
    for (const token of parser.parse(content, {})) {
        if (token.type === "html_block") html.push(token.content);
        for (const child of token.children ?? []) {
            if (child.type === "link_open") hrefs.push(child.attrGet("href") ?? "");
            else if (child.type === "html_inline") html.push(child.content);
        }
    }
    const markup = html.join("").replace(COMMENT, "").replace(PRE, "");
    for (const match of markup.matchAll(ANCHOR_HREF)) hrefs.push(match[1]);
    return hrefs;
}

function decode(value) {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

export class MarkdownGraph {
    /** @param {Record<string, string>} documents repository-relative path -> content */
    constructor(documents) {
        this.documents = new Set(Object.keys(documents));
        this.links = new Map();
        for (const [path, content] of Object.entries(documents)) {
            const targets = destinations(content)
                .map((href) => this.localTarget(path, href))
                .filter((target) => target !== undefined);
            this.links.set(path, [...new Set(targets)]);
        }
    }

    static fromRepository(root) {
        let output;
        try {
            output = execFileSync(
                "git",
                ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
                {
                    cwd: root,
                    encoding: "utf8",
                    stdio: ["ignore", "pipe", "pipe"],
                },
            );
        } catch (error) {
            throw new Error(`cannot inventory documentation: ${error.message}`);
        }
        const documents = {};
        for (const path of output.split("\0")) {
            const full = posix.join(root, path);
            if (path.toLowerCase().endsWith(".md") && existsSync(full))
                documents[path] = readFileSync(full, "utf8");
        }
        return new MarkdownGraph(documents);
    }

    localTarget(source, href) {
        if (!href || EXTERNAL.test(href)) return undefined;
        const destination = decode(href.split(/[?#]/, 1)[0]);
        const target = destination.startsWith("/")
            ? posix.normalize(destination.replace(/^\/+/, ""))
            : posix.normalize(posix.join(posix.dirname(source), destination));
        if (target === ".." || target.startsWith("../")) return undefined;
        if (target.toLowerCase().endsWith(".md")) return target;
        const readme = posix.join(target, "README.md");
        return this.documents.has(readme) ? readme : undefined;
    }

    paths() {
        return [...this.documents].sort();
    }

    unreachable(entrypoint = ENTRYPOINT) {
        const visited = new Set();
        const pending = [entrypoint];
        while (pending.length > 0) {
            const path = pending.pop();
            if (!this.documents.has(path) || visited.has(path)) continue;
            visited.add(path);
            pending.push(...this.links.get(path));
        }
        return this.paths().filter((path) => !visited.has(path));
    }

    missingTargets(sources) {
        const missing = {};
        for (const source of sources) {
            const targets = (this.links.get(source) ?? [])
                .filter((target) => !this.documents.has(target))
                .sort();
            if (targets.length > 0) missing[source] = targets;
        }
        return missing;
    }
}

function globSegment(text, pattern) {
    const regex = pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, "[^/]*")
        .replace(/\?/g, "[^/]");
    return new RegExp(`^${regex}$`).test(text);
}

export class Exemptions {
    constructor(patterns) {
        this.patterns = patterns.map((pattern) => pattern.replace(/^\/+/, ""));
    }

    static load(root, name = IGNORE_FILE) {
        const file = posix.join(root, name);
        const lines = existsSync(file) ? readFileSync(file, "utf8").split(/\r?\n/) : [];
        return new Exemptions(
            lines.map((line) => line.trim()).filter((line) => line && !line.startsWith("#")),
        );
    }

    matches(path) {
        const parts = path.split("/");
        return this.patterns.some((pattern) => {
            const patternParts = pattern.replace(/\/$/, "").split("/");
            if (pattern.endsWith("/")) {
                return (
                    parts.length > patternParts.length &&
                    patternParts.every((p, i) => globSegment(parts[i], p))
                );
            }
            return (
                parts.length === patternParts.length &&
                patternParts.every((p, i) => globSegment(parts[i], p))
            );
        });
    }

    filter(paths) {
        return paths.filter((path) => !this.matches(path));
    }
}

export function check(root) {
    const graph = MarkdownGraph.fromRepository(root);
    const exempt = Exemptions.load(root);
    const errors = [];
    const orphans = exempt.filter(graph.unreachable());
    if (orphans.length > 0) {
        errors.push(
            `Markdown files unreachable from ${ENTRYPOINT} (${orphans.length}):\n` +
                orphans.map((path) => `  - ${path}\n`).join("") +
                "Link each one from its natural parent (README section, ARCHITECTURE.md, a guide or index). " +
                `Use ${IGNORE_FILE} only for intentionally unindexed history.`,
        );
    }
    const missing = graph.missingTargets(exempt.filter(graph.paths()));
    if (Object.keys(missing).length > 0) {
        errors.push(
            "Markdown links to missing documents:\n" +
                Object.entries(missing)
                    .map(([source, targets]) => `  - ${source} -> ${targets.join(", ")}\n`)
                    .join(""),
        );
    }
    return errors;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
    const errors = check(root);
    for (const error of errors) console.error(error);
    if (errors.length === 0)
        console.log("Markdown coverage: every document is reachable from README.md.");
    process.exit(errors.length > 0 ? 1 : 0);
}
