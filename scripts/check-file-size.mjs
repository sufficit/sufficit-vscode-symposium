// Guardrail: no source file may exceed MAX_LINES.
// Part of PLAN-namespace-restructure — keeps the 400-line rule permanent.
// The point isn't to lose functionality when a file goes over — it's to
// distribute responsibilities into smaller, focused collaborator files
// (the controllerXxx.ts / turnXxx.ts / chatSurfaceXxx.ts pattern already
// used throughout this codebase) so the code stays easier to maintain.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const MAX_LINES = 400;
const ROOT = "src";

/** @param {string} dir @returns {string[]} */
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (extname(full) === ".ts") out.push(full);
  }
  return out;
}

const offenders = [];
for (const file of walk(ROOT)) {
  const lines = readFileSync(file, "utf8").trimEnd().split("\n").length;
  if (lines > MAX_LINES) offenders.push({ file, lines });
}

if (offenders.length) {
  offenders.sort((a, b) => b.lines - a.lines);
  console.error(`✗ ${offenders.length} file(s) over ${MAX_LINES} lines:`);
  for (const { file, lines } of offenders) console.error(`  ${lines}\t${file}`);
  process.exit(1);
}
console.log(`✓ all source files <= ${MAX_LINES} lines`);
