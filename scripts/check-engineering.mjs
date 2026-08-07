#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import ts from "typescript";

const ROOT = "src";
const failures = [];

function walk(dir) {
    const files = [];
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
            if (entry !== "test") files.push(...walk(full));
        } else if (extname(full) === ".ts" && !full.endsWith(".d.ts")) {
            files.push(full);
        }
    }
    return files;
}

function stringLiteral(node) {
    return node && ts.isStringLiteralLike(node) ? node.text : undefined;
}

function configurationSection(call) {
    if (!ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression)) return undefined;
    if (call.expression.name.text !== "getConfiguration") return undefined;
    return stringLiteral(call.arguments[0]) ?? "";
}

function configurationContracts(files) {
    const manifest = JSON.parse(readFileSync("package.json", "utf8"));
    const declared = new Set(Object.keys(manifest.contributes?.configuration?.properties ?? {}));
    const uses = [];

    for (const file of files) {
        const source = readFileSync(file, "utf8");
        const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
        const aliases = [];

        function collectAliases(node) {
            if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
                const section = configurationSection(node.initializer);
                if (section !== undefined) {
                    aliases.push({ name: node.name.text, section, position: node.getStart(sourceFile) });
                }
            }
            ts.forEachChild(node, collectAliases);
        }
        collectAliases(sourceFile);

        function visit(node) {
            if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
                const method = node.expression.name.text;
                if (["get", "has", "inspect", "update"].includes(method)) {
                    const receiver = node.expression.expression;
                    let section;
                    if (ts.isIdentifier(receiver)) {
                        section = aliases
                            .filter(
                                (alias) =>
                                    alias.name === receiver.text &&
                                    alias.position < node.getStart(sourceFile),
                            )
                            .sort((a, b) => b.position - a.position)[0]?.section;
                    }
                    else section = configurationSection(receiver);
                    const key = stringLiteral(node.arguments[0]);
                    if (section !== undefined && key) {
                        const full = section ? `${section}.${key}` : key;
                        if (full.startsWith("symposium.")) {
                            const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
                            uses.push({ full, file, line, method });
                        }
                    }
                }
            }
            ts.forEachChild(node, visit);
        }
        visit(sourceFile);
    }

    for (const use of uses) {
        if (!declared.has(use.full)) {
            failures.push(
                `${use.file}:${use.line} ${use.method}() uses undeclared setting ${use.full}`,
            );
        }
    }
    console.log(`✓ checked ${new Set(uses.map((use) => use.full)).size} static configuration keys`);
}

function exportedObject(file, exportName) {
    const sourceFile = ts.createSourceFile(
        file,
        readFileSync(file, "utf8"),
        ts.ScriptTarget.Latest,
        true,
    );
    for (const statement of sourceFile.statements) {
        if (!ts.isVariableStatement(statement)) continue;
        for (const declaration of statement.declarationList.declarations) {
            if (
                ts.isIdentifier(declaration.name) &&
                declaration.name.text === exportName &&
                declaration.initializer &&
                ts.isObjectLiteralExpression(declaration.initializer)
            ) {
                const values = new Map();
                for (const property of declaration.initializer.properties) {
                    if (!ts.isPropertyAssignment(property)) continue;
                    const key = stringLiteral(property.name) ??
                        (ts.isIdentifier(property.name) ? property.name.text : undefined);
                    const value = stringLiteral(property.initializer);
                    if (key && value !== undefined) values.set(key, value);
                }
                return values;
            }
        }
    }
    throw new Error(`Could not find ${exportName} in ${file}`);
}

function i18nContracts() {
    const english = exportedObject("src/ui/configI18nEn.ts", "CONFIG_EN");
    const portuguese = exportedObject("src/ui/configI18nPt.ts", "CONFIG_PT");

    for (const key of english.keys()) {
        if (!portuguese.has(key)) failures.push(`CONFIG_PT is missing key ${key}`);
    }
    for (const key of portuguese.keys()) {
        if (!english.has(key)) failures.push(`CONFIG_EN is missing key ${key}`);
    }

    const portugueseWords = /\b(não|falha|nenhum|erro|fornecid[ao]|encontrad[ao]s?|modelos?)\b/i;
    for (const [key, value] of english) {
        if (portugueseWords.test(value)) {
            failures.push(`CONFIG_EN key ${key} contains Portuguese text: ${JSON.stringify(value)}`);
        }
    }
    console.log(`✓ checked ${english.size} EN and ${portuguese.size} PT-BR configuration strings`);
}

function repositoryArtifacts() {
    const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" })
        .split(/\r?\n/)
        .filter((file) => file && existsSync(file));
    const backups = tracked.filter((file) => /\.(old|bak|orig)$/i.test(file));
    for (const file of backups) failures.push(`tracked backup artifact: ${file}`);
    console.log(`✓ checked ${tracked.length} tracked paths for backup artifacts`);
}

const files = walk(ROOT);
configurationContracts(files);
i18nContracts();
repositoryArtifacts();

if (failures.length) {
    console.error(`✗ engineering guardrails found ${failures.length} issue(s):`);
    for (const failure of failures) console.error(`  ${failure}`);
    process.exit(1);
}

console.log(`✓ engineering guardrails passed for ${files.length} production TypeScript modules`);
