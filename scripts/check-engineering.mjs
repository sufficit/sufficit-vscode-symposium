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
    const imported = new Map();
    for (const statement of sourceFile.statements) {
        if (
            ts.isImportDeclaration(statement) &&
            ts.isStringLiteral(statement.moduleSpecifier) &&
            statement.importClause?.namedBindings &&
            ts.isNamedImports(statement.importClause.namedBindings)
        ) {
            for (const element of statement.importClause.namedBindings.elements) {
                imported.set(element.name.text, {
                    exported: element.propertyName?.text ?? element.name.text,
                    module: statement.moduleSpecifier.text,
                });
            }
        }
    }
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
                    if (ts.isSpreadAssignment(property) && ts.isIdentifier(property.expression)) {
                        const source = imported.get(property.expression.text);
                        if (source?.module.startsWith(".")) {
                            const dependency = join(
                                file.slice(0, file.lastIndexOf("/") + 1),
                                `${source.module}.ts`,
                            );
                            for (const [key, value] of exportedObject(
                                dependency,
                                source.exported,
                            )) {
                                values.set(key, value);
                            }
                        }
                        continue;
                    }
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

function isExported(statement) {
    return statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
}

function objectProperty(object, name) {
    return object.properties.find(
        (property) =>
            ts.isPropertyAssignment(property) &&
            (stringLiteral(property.name) ??
                (ts.isIdentifier(property.name) ? property.name.text : undefined)) === name,
    );
}

function featureContracts(files) {
    const featureFiles = files.filter((file) => file.endsWith("/feature.ts")).sort();
    const catalogPath = "src/features/catalog.ts";
    const publicIndexPath = "src/features/index.ts";
    const catalogSource = readFileSync(catalogPath, "utf8");
    const catalogFile = ts.createSourceFile(
        catalogPath,
        catalogSource,
        ts.ScriptTarget.Latest,
        true,
    );
    const catalogImports = new Set(
        catalogFile.statements
            .filter(ts.isImportDeclaration)
            .map((statement) => stringLiteral(statement.moduleSpecifier))
            .filter((specifier) => specifier?.endsWith("/feature")),
    );
    const publicIndex = ts.createSourceFile(
        publicIndexPath,
        readFileSync(publicIndexPath, "utf8"),
        ts.ScriptTarget.Latest,
        true,
    );
    const publicExports = new Set(
        publicIndex.statements
            .filter(ts.isExportDeclaration)
            .map((statement) => stringLiteral(statement.moduleSpecifier))
            .filter((specifier) => specifier?.endsWith("/feature")),
    );
    const namespaces = new Map();
    const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

    for (const file of featureFiles) {
        const source = readFileSync(file, "utf8");
        const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
        const versions = [];
        const definitions = [];

        for (const statement of sourceFile.statements) {
            if (!ts.isVariableStatement(statement) || !isExported(statement)) continue;
            for (const declaration of statement.declarationList.declarations) {
                if (!ts.isIdentifier(declaration.name)) continue;
                const name = declaration.name.text;
                if (name.endsWith("_FEATURE_VERSION")) {
                    versions.push({ name, version: stringLiteral(declaration.initializer) });
                    continue;
                }
                if (
                    !name.endsWith("_FEATURE") ||
                    !declaration.initializer ||
                    !ts.isCallExpression(declaration.initializer) ||
                    !ts.isIdentifier(declaration.initializer.expression) ||
                    declaration.initializer.expression.text !== "defineFeature"
                ) {
                    continue;
                }
                const definition = declaration.initializer.arguments[0];
                if (!definition || !ts.isObjectLiteralExpression(definition)) continue;
                const namespaceProperty = objectProperty(definition, "namespace");
                const versionProperty = objectProperty(definition, "version");
                const descriptionProperty = objectProperty(definition, "description");
                definitions.push({
                    name,
                    namespace:
                        namespaceProperty && ts.isPropertyAssignment(namespaceProperty)
                            ? stringLiteral(namespaceProperty.initializer)
                            : undefined,
                    versionName:
                        versionProperty &&
                        ts.isPropertyAssignment(versionProperty) &&
                        ts.isIdentifier(versionProperty.initializer)
                            ? versionProperty.initializer.text
                            : undefined,
                    description:
                        descriptionProperty && ts.isPropertyAssignment(descriptionProperty)
                            ? stringLiteral(descriptionProperty.initializer)
                            : undefined,
                });
            }
        }

        if (versions.length !== 1) {
            failures.push(`${file} must export exactly one *_FEATURE_VERSION constant`);
        }
        if (definitions.length !== 1) {
            failures.push(`${file} must export exactly one *_FEATURE defined with defineFeature()`);
        }
        const version = versions[0];
        const definition = definitions[0];
        if (version && (!version.version || !semver.test(version.version))) {
            failures.push(
                `${file} has invalid semantic feature version ${String(version.version)}`,
            );
        }
        if (definition) {
            if (
                !definition.namespace?.match(/^symposium\.[a-z][a-z0-9]*(?:[.-][a-z][a-z0-9]*)*$/)
            ) {
                failures.push(
                    `${file} has invalid feature namespace ${String(definition.namespace)}`,
                );
            } else if (namespaces.has(definition.namespace)) {
                failures.push(
                    `${file} duplicates namespace ${definition.namespace} from ${namespaces.get(definition.namespace)}`,
                );
            } else {
                namespaces.set(definition.namespace, file);
            }
            if (version && definition.versionName !== version.name) {
                failures.push(`${file} feature definition must reference ${version.name}`);
            }
            if (!definition.description?.trim()) {
                failures.push(`${file} feature definition must include a description`);
            }
        }

        const modulePath = `../${file.slice("src/".length, -".ts".length)}`;
        if (!catalogImports.has(modulePath)) {
            failures.push(`${file} is missing from ${catalogPath}`);
        }
        if (!publicExports.has(modulePath)) {
            failures.push(`${file} is not publicly exported by ${publicIndexPath}`);
        }
        const directory = file.slice(0, file.lastIndexOf("/"));
        const barrel = `${directory}/index.ts`;
        if (
            existsSync(barrel) &&
            !/from\s+["']\.\/feature["']/.test(readFileSync(barrel, "utf8"))
        ) {
            failures.push(`${barrel} must export its local feature metadata`);
        }
    }

    if (catalogImports.size !== featureFiles.length) {
        failures.push(
            `${catalogPath} imports ${catalogImports.size} feature modules but ${featureFiles.length} exist`,
        );
    }
    if (publicExports.size !== featureFiles.length) {
        failures.push(
            `${publicIndexPath} exports ${publicExports.size} feature modules but ${featureFiles.length} exist`,
        );
    }
    console.log(`✓ checked ${featureFiles.length} versioned feature namespaces`);
}

const files = walk(ROOT);
configurationContracts(files);
i18nContracts();
repositoryArtifacts();
featureContracts(files);

if (failures.length) {
    console.error(`✗ engineering guardrails found ${failures.length} issue(s):`);
    for (const failure of failures) console.error(`  ${failure}`);
    process.exit(1);
}

console.log(`✓ engineering guardrails passed for ${files.length} production TypeScript modules`);
