#!/usr/bin/env node

import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import ts from "typescript";

const ROOT = "src";
const MAX_FUNCTION_LINES = 80;
const MAX_COMPLEXITY = 15;
const WARNING_FILE_LINES = 300;
const STRICT = process.env.STRICT_COMPLEXITY === "1";
const MAX_REPORTED_TARGETS = 25;

function walk(directory) {
    const files = [];
    for (const entry of readdirSync(directory)) {
        const path = join(directory, entry);
        if (statSync(path).isDirectory()) files.push(...walk(path));
        else if (extname(path) === ".ts" && !path.endsWith(".d.ts")) files.push(path);
    }
    return files;
}

function isFunction(node) {
    return (
        ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isConstructorDeclaration(node) ||
        ts.isGetAccessorDeclaration(node) ||
        ts.isSetAccessorDeclaration(node)
    );
}

function functionName(node, sourceFile) {
    if (node.name && ts.isIdentifier(node.name)) return node.name.text;
    if (ts.isConstructorDeclaration(node)) return "constructor";
    const parent = node.parent;
    if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
    if (ts.isPropertyAssignment(parent)) return parent.name.getText(sourceFile);
    return "<anonymous>";
}

function complexity(root) {
    let score = 1;
    function visit(node) {
        if (node !== root && isFunction(node)) return;
        if (
            ts.isIfStatement(node) ||
            ts.isForStatement(node) ||
            ts.isForInStatement(node) ||
            ts.isForOfStatement(node) ||
            ts.isWhileStatement(node) ||
            ts.isDoStatement(node) ||
            ts.isCatchClause(node) ||
            ts.isConditionalExpression(node)
        ) {
            score++;
        } else if (ts.isCaseClause(node)) {
            score++;
        } else if (
            ts.isBinaryExpression(node) &&
            [
                ts.SyntaxKind.AmpersandAmpersandToken,
                ts.SyntaxKind.BarBarToken,
                ts.SyntaxKind.QuestionQuestionToken,
            ].includes(node.operatorToken.kind)
        ) {
            score++;
        }
        ts.forEachChild(node, visit);
    }
    visit(root);
    return score;
}

const targets = [];
const warnings = [];
for (const file of walk(ROOT)) {
    const source = readFileSync(file, "utf8");
    const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const fileLines = source.trimEnd().split("\n").length;
    if (fileLines > WARNING_FILE_LINES) warnings.push(`${file}:${fileLines} file lines`);
    function visit(node) {
        if (isFunction(node) && node.body) {
            const start =
                sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
            const end = sourceFile.getLineAndCharacterOfPosition(node.end).line + 1;
            const lines = end - start + 1;
            const decisions = complexity(node);
            const name = functionName(node, sourceFile);
            if (lines > MAX_FUNCTION_LINES) {
                targets.push(
                    `${file}:${start} ${name} spans ${lines} lines (max ${MAX_FUNCTION_LINES})`,
                );
            }
            if (decisions > MAX_COMPLEXITY) {
                targets.push(
                    `${file}:${start} ${name} complexity ${decisions} (max ${MAX_COMPLEXITY})`,
                );
            }
        }
        ts.forEachChild(node, visit);
    }
    visit(sourceFile);
}

if (warnings.length) {
    console.warn(
        `⚠ ${warnings.length} file(s) above the ${WARNING_FILE_LINES}-line refactor target ` +
            `(the hard 400-line contract is enforced by check:size)`,
    );
}
if (targets.length) {
    const report = STRICT ? console.error : console.warn;
    report(
        `${STRICT ? "✗" : "⚠"} ${targets.length} function complexity/size target(s) remain ` +
            `(lines <= ${MAX_FUNCTION_LINES}, complexity <= ${MAX_COMPLEXITY})`,
    );
    for (const target of targets.slice(0, MAX_REPORTED_TARGETS)) report(`  ${target}`);
    if (targets.length > MAX_REPORTED_TARGETS) {
        report(`  … ${targets.length - MAX_REPORTED_TARGETS} additional target(s)`);
    }
    if (STRICT) process.exit(1);
}
console.log(
    `✓ complexity inventory completed with no named baseline or exception list; ` +
        `${warnings.length} file warning(s), ${targets.length} function target(s)`,
);
