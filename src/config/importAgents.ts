import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { ensureScaffold, repoDir, sanitize } from "./root";

interface ParsedAgent { name: string; description: string; model: string; body: string; }

/** Line-based frontmatter reader (mirrors root.ts's intentionally-trivial parser). */
function parse(text: string): ParsedAgent | null {
    if (!text.startsWith("---")) { return null; }
    const end = text.indexOf("\n---", 3);
    if (end === -1) { return null; }
    const fm: Record<string, string> = {};
    for (const line of text.slice(3, end).split("\n")) {
        const m = /^([a-zA-Z_-]+)\s*:\s*(.*)$/.exec(line);
        if (m) { fm[m[1]] = m[2].trim().replace(/^["']|["']$/g, ""); }
    }
    const body = text.slice(end + 4).replace(/^\s*\n/, "");
    return { name: fm.name || "", description: fm.description || "", model: fm.model || "", body };
}

/** Renders a parsed external agent as a canonical Symposium agent-def. */
function toAgentDef(a: ParsedAgent, fallbackName: string): { name: string; content: string } {
    const name = a.name || fallbackName;
    // tools/skills/instructions start empty: foreign tool names (Read, Grep…) are
    // not Symposium tool-def names, so importing them raw would dangle. The body
    // (the agent's system prompt) is preserved verbatim — that's the valuable part.
    const fm = [
        `name: ${name}`,
        `description: ${a.description}`,
        `model: ${a.model || "default"}`,
        "backend: ''",
        "bootstrap: true",
        "tools: []",
        "skills: []",
        "instructions: []",
        "version: 1",
    ];
    return { name, content: `---\n${fm.join("\n")}\n---\n\n${a.body}` };
}

/**
 * Imports existing CLI agents into ~/.symposium/repo/agents as native agent-defs:
 *  - Claude Code subagents: `<workspace>/.claude/agents/*.md` and `~/.claude/agents/*.md`
 *  - Codex skill bundles:   `~/.codex/skills/<name>/SKILL.md`
 * Never overwrites an existing agent-def of the same name (idempotent re-import).
 */
export function importAgents(): { created: number; skipped: number } {
    ensureScaffold();
    const dest = path.join(repoDir(), "agents");
    let created = 0, skipped = 0;
    const home = os.homedir();
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    const write = (def: { name: string; content: string } | null) => {
        if (!def || !def.name) { return; }
        const file = path.join(dest, sanitize(def.name) + ".md");
        if (fs.existsSync(file)) { skipped++; return; }
        fs.writeFileSync(file, def.content, "utf8");
        created++;
    };

    // Claude Code subagents (single .md files, workspace first then global).
    for (const dir of [ws && path.join(ws, ".claude", "agents"), path.join(home, ".claude", "agents")].filter(Boolean) as string[]) {
        let files: string[];
        try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".md")); } catch { continue; }
        for (const f of files) {
            try {
                const parsed = parse(fs.readFileSync(path.join(dir, f), "utf8"));
                if (parsed) { write(toAgentDef(parsed, f.replace(/\.md$/, ""))); }
            } catch { /* skip unreadable */ }
        }
    }

    // Codex skill bundles → agent-defs (~/.codex/skills/<name>/SKILL.md).
    const codexSkills = path.join(home, ".codex", "skills");
    let dirs: fs.Dirent[];
    try { dirs = fs.readdirSync(codexSkills, { withFileTypes: true }); } catch { dirs = []; }
    for (const e of dirs) {
        if (!e.isDirectory() || e.name.startsWith(".")) { continue; }
        try {
            const parsed = parse(fs.readFileSync(path.join(codexSkills, e.name, "SKILL.md"), "utf8"));
            if (parsed) { write(toAgentDef(parsed, e.name)); }
        } catch { /* skip */ }
    }

    return { created, skipped };
}
