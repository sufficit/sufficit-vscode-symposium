#!/usr/bin/env node

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const root = path.resolve("src");
const baseline = JSON.parse(readFileSync("scripts/architecture-baseline.json", "utf8"));
const files = [];
const failures = [];

function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory() && entry.name !== "test") walk(full);
        else if (entry.isFile() && full.endsWith(".ts") && !full.endsWith(".d.ts")) {
            files.push(path.normalize(full));
        }
    }
}

walk(root);
const fileSet = new Set(files);

function display(file) {
    return path.relative(root, file).split(path.sep).join("/");
}

function resolveRelative(from, specifier) {
    if (!specifier.startsWith(".")) return undefined;
    const base = path.resolve(path.dirname(from), specifier);
    return [base + ".ts", path.join(base, "index.ts")]
        .map((candidate) => path.normalize(candidate))
        .find((candidate) => fileSet.has(candidate));
}

const graph = new Map(files.map((file) => [file, new Set()]));
for (const file of files) {
    const sourceFile = ts.createSourceFile(
        file,
        readFileSync(file, "utf8"),
        ts.ScriptTarget.Latest,
        true,
    );
    function add(specifier) {
        const target = resolveRelative(file, specifier);
        if (target) graph.get(file).add(target);
    }
    function visit(node) {
        if (
            (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
            node.moduleSpecifier &&
            ts.isStringLiteralLike(node.moduleSpecifier)
        ) {
            add(node.moduleSpecifier.text);
        } else if (
            ts.isCallExpression(node) &&
            node.expression.kind === ts.SyntaxKind.ImportKeyword &&
            ts.isStringLiteralLike(node.arguments[0])
        ) {
            add(node.arguments[0].text);
        } else if (
            ts.isCallExpression(node) &&
            ts.isIdentifier(node.expression) &&
            node.expression.text === "require" &&
            ts.isStringLiteralLike(node.arguments[0])
        ) {
            add(node.arguments[0].text);
        }
        ts.forEachChild(node, visit);
    }
    visit(sourceFile);
}

function stronglyConnectedComponents() {
    let nextIndex = 0;
    const stack = [];
    const onStack = new Set();
    const indices = new Map();
    const lowLinks = new Map();
    const components = [];

    function visit(file) {
        indices.set(file, nextIndex);
        lowLinks.set(file, nextIndex);
        nextIndex += 1;
        stack.push(file);
        onStack.add(file);

        for (const target of graph.get(file)) {
            if (!indices.has(target)) {
                visit(target);
                lowLinks.set(file, Math.min(lowLinks.get(file), lowLinks.get(target)));
            } else if (onStack.has(target)) {
                lowLinks.set(file, Math.min(lowLinks.get(file), indices.get(target)));
            }
        }

        if (lowLinks.get(file) === indices.get(file)) {
            const component = [];
            let current;
            do {
                current = stack.pop();
                onStack.delete(current);
                component.push(current);
            } while (current !== file);
            if (component.length > 1) components.push(component);
        }
    }

    for (const file of files) if (!indices.has(file)) visit(file);
    return components;
}

function signature(items) {
    return [...items].map(display).sort().join("|");
}

const actualCycles = new Set(stronglyConnectedComponents().map(signature));
const allowedCycles = new Set(baseline.allowedCycles.map((cycle) => [...cycle].sort().join("|")));
for (const cycle of actualCycles) {
    if (!allowedCycles.has(cycle)) failures.push(`new or expanded dependency cycle: ${cycle}`);
}
for (const cycle of allowedCycles) {
    if (!actualCycles.has(cycle)) failures.push(`stale cycle baseline (remove it): ${cycle}`);
}

const actualBoundaryViolations = new Set();
for (const [source, targets] of graph) {
    const sourceName = display(source);
    for (const target of targets) {
        const targetName = display(target);
        if (
            (sourceName.startsWith("ui/") && targetName === "extension.ts") ||
            (sourceName.startsWith("sessions/") && targetName.startsWith("ui/"))
        ) {
            actualBoundaryViolations.add(`${sourceName} -> ${targetName}`);
        }
    }
}
const allowedBoundaryViolations = new Set(baseline.allowedBoundaryViolations);
for (const edge of actualBoundaryViolations) {
    if (!allowedBoundaryViolations.has(edge)) failures.push(`new boundary violation: ${edge}`);
}
for (const edge of allowedBoundaryViolations) {
    if (!actualBoundaryViolations.has(edge)) failures.push(`stale boundary baseline (remove it): ${edge}`);
}

const reachable = new Set();
function markReachable(file) {
    if (!file || reachable.has(file)) return;
    reachable.add(file);
    for (const target of graph.get(file) ?? []) markReachable(target);
}
for (const entry of ["extension.ts", "ui/webview/index.ts", "ui/webview/pwaShim.ts"]) {
    markReachable(path.join(root, entry));
}
const unreachable = new Set(files.filter((file) => !reachable.has(file)).map(display));
const allowedUnreachable = new Set(baseline.allowedUnreachableModules);
for (const file of unreachable) {
    if (!allowedUnreachable.has(file)) failures.push(`new unreachable production module: ${file}`);
}
for (const file of allowedUnreachable) {
    if (!unreachable.has(file)) failures.push(`stale unreachable baseline (remove it): ${file}`);
}

if (failures.length) {
    console.error(`✗ architecture guardrails found ${failures.length} issue(s):`);
    for (const failure of failures) console.error(`  ${failure}`);
    process.exit(1);
}

console.log(
    `✓ architecture ratchet passed: ${files.length} modules, ` +
        `${actualCycles.size} known cycles, ${unreachable.size} known unreachable modules`,
);
