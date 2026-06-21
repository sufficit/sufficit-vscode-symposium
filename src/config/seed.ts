import * as fs from "fs";
import * as path from "path";
import { ensureScaffold, repoDir } from "./root";

/**
 * Writes a small set of example, vendor-neutral resources into ~/.symposium/repo
 * so the configuration UI and the public API can be validated fully offline,
 * with no sufficit-ai hub required. Existing files are never overwritten.
 */

interface SeedFile {
    rel: string;
    body: string;
}

const SEED: SeedFile[] = [
    {
        rel: "agents/code-reviewer.md",
        body: `---
name: code-reviewer
description: Reviews diffs for correctness bugs and simplifications.
model: default
tools: [filesystem-read]
skills: [diff-summary]
instructions: [concise-style]
version: 1
---

# code-reviewer

Review the current diff. Report correctness bugs first, then simplifications.
One line per finding, with severity and a suggested fix.
`,
    },
    {
        rel: "agents/test-writer.md",
        body: `---
name: test-writer
description: Writes tests for the changed code.
model: default
tools: [filesystem-read]
skills: []
instructions: [concise-style]
version: 1
---

# test-writer

Generate tests covering the happy path and edge cases of the recently changed code.
`,
    },
    {
        rel: "tools/filesystem-read.md",
        body: `---
name: filesystem-read
description: Read-only filesystem access via MCP.
transport: stdio
command: 'mcp-server-filesystem --readonly'
capabilities: [read, list, search]
credentialRef: ''
version: 1
---

# filesystem-read

Read-only file access MCP tool. No secret.
`,
    },
    {
        rel: "tools/sufficit-memory.md",
        body: `---
name: sufficit-memory
description: Access to the Sufficit memory hub (REST).
transport: http
url: 'https://ai.sufficit.com.br/api/memory'
capabilities: [search, save, timeline]
credentialRef: 'sufficit/memory-token'
version: 1
---

# sufficit-memory

Memory tool. Secret resolved by the vault via credentialRef (never in the file).
`,
    },
    {
        rel: "skills/diff-summary/SKILL.md",
        body: `---
name: diff-summary
description: Summarizes a git diff into concise points.
version: 1
---

# diff-summary

Summarize the diff as bullets: files touched, intent, risks.
`,
    },
    {
        rel: "skills/diff-summary/scripts/run.sh",
        body: `#!/usr/bin/env bash
# Example skill script (bundle).
git diff --stat
`,
    },
    {
        rel: "instructions/concise-style.md",
        body: `---
name: concise-style
description: Answer concisely and technically, avoiding redundancy.
version: 1
---

# concise-style

Be concise and technical. Avoid redundancy.
`,
    },
];

/** Returns how many example files were created (skips existing ones). */
export function seedExamples(): number {
    ensureScaffold();
    let created = 0;
    for (const file of SEED) {
        const abs = path.join(repoDir(), file.rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        if (!fs.existsSync(abs)) {
            fs.writeFileSync(abs, file.body, "utf8");
            created++;
        }
    }
    return created;
}
