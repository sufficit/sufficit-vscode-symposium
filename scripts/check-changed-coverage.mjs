#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const base = String(process.env.COVERAGE_BASE_SHA || "").trim();
if (!base) {
    console.log("Changed-line coverage: skipped (COVERAGE_BASE_SHA is not set)");
    process.exit(0);
}

const reportPath = path.resolve("coverage/coverage-final.json");
if (!existsSync(reportPath)) {
    console.error("Changed-line coverage: coverage/coverage-final.json is missing");
    process.exit(1);
}

let diff;
try {
    diff = execFileSync("git", ["diff", "--unified=0", `${base}...HEAD`, "--", "src/**/*.ts"], {
        encoding: "utf8",
    });
} catch (error) {
    console.error(`Changed-line coverage: unable to diff against ${base}: ${error.message}`);
    process.exit(1);
}

const changed = new Map();
let currentFile;
for (const line of diff.split("\n")) {
    if (line.startsWith("+++ b/")) {
        currentFile = path.resolve(line.slice(6));
        continue;
    }
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (!currentFile || !hunk) {
        continue;
    }
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    const lines = changed.get(currentFile) ?? new Set();
    for (let offset = 0; offset < count; offset++) {
        lines.add(start + offset);
    }
    changed.set(currentFile, lines);
}

const coverage = JSON.parse(readFileSync(reportPath, "utf8"));
let executable = 0;
let covered = 0;
const misses = [];
for (const [file, lines] of changed) {
    if (file.includes(`${path.sep}src${path.sep}test${path.sep}`)) {
        continue;
    }
    const entry = coverage[file] ?? coverage[path.relative(process.cwd(), file)];
    if (!entry) {
        continue;
    }
    const lineHits = new Map();
    for (const [statementId, location] of Object.entries(entry.statementMap ?? {})) {
        const lineNo = location.start.line;
        const hits = Number(entry.s?.[statementId] ?? 0);
        lineHits.set(lineNo, Math.max(lineHits.get(lineNo) ?? 0, hits));
    }
    for (const lineNo of lines) {
        if (!lineHits.has(lineNo)) {
            continue;
        }
        executable++;
        if ((lineHits.get(lineNo) ?? 0) > 0) {
            covered++;
        } else {
            misses.push(`${path.relative(process.cwd(), file)}:${lineNo}`);
        }
    }
}

if (!executable) {
    console.log("Changed-line coverage: no changed executable production lines");
    process.exit(0);
}
const percent = (covered / executable) * 100;
console.log(
    `Changed-line coverage: ${percent.toFixed(2)}% (${covered}/${executable}, target 85%)`,
);
if (percent < 85) {
    console.error(`Uncovered changed lines: ${misses.slice(0, 30).join(", ")}`);
    process.exit(1);
}
