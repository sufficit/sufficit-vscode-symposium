// Guardrail: no source file may exceed MAX_LINES.
// Part of PLAN-namespace-restructure — keeps the 400-line rule permanent.
// Webview blob files are temporarily exempt until Phase 2 extracts them.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const MAX_LINES = 400;
const ROOT = "src";
// Grandfathered offenders: already over the limit when the guard was fixed.
// Do not add new entries — shrink these below 400 lines and remove them.
const EXEMPT = new Set([
  "src/adapters/aiTools/defs.ts",
  "src/adapters/openai/session.ts",
  "src/adapters/openai/turnRunner.ts",
  "src/api/symposiumApi.ts",
  "src/config/root.ts",
  "src/ui/chatController.ts",
  "src/ui/configI18n.ts",
  "src/ui/configPanel.ts",
  "src/ui/configStyles.ts",
  "src/ui/configViews.ts",
  "src/ui/surfaceDialogues.ts",
  "src/ui/surfaceMessages.ts",
  "src/ui/webview/composer.ts",
  "src/ui/webview/dispatch.ts",
  "src/ui/webview/sessions.ts",
]);

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
  if (EXEMPT.has(file)) continue;
  const lines = readFileSync(file, "utf8").split("\n").length;
  if (lines > MAX_LINES) offenders.push({ file, lines });
}

if (offenders.length) {
  offenders.sort((a, b) => b.lines - a.lines);
  console.error(`✗ ${offenders.length} file(s) over ${MAX_LINES} lines:`);
  for (const { file, lines } of offenders) console.error(`  ${lines}\t${file}`);
  process.exit(1);
}
console.log(`✓ all source files <= ${MAX_LINES} lines`);
