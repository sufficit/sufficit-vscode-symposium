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
description: Revisa diffs buscando bugs de correção e simplificações.
model: default
tools: [filesystem-read]
skills: [diff-summary]
instructions: [pt-br-style]
version: 1
---

# code-reviewer

Revise o diff atual. Aponte bugs de correção primeiro, depois simplificações.
Uma linha por achado, com severidade e correção sugerida.
`,
    },
    {
        rel: "agents/test-writer.md",
        body: `---
name: test-writer
description: Escreve testes para o código alterado.
model: default
tools: [filesystem-read]
skills: []
instructions: [pt-br-style]
version: 1
---

# test-writer

Gere testes cobrindo o caminho feliz e casos de borda do código recém-alterado.
`,
    },
    {
        rel: "tools/filesystem-read.md",
        body: `---
name: filesystem-read
description: Acesso somente-leitura ao sistema de arquivos via MCP.
transport: stdio
command: 'mcp-server-filesystem --readonly'
capabilities: [read, list, search]
credentialRef: ''
version: 1
---

# filesystem-read

Tool MCP de leitura de arquivos. Sem segredo.
`,
    },
    {
        rel: "tools/sufficit-memory.md",
        body: `---
name: sufficit-memory
description: Acesso ao hub de memórias Sufficit (REST).
transport: http
url: 'https://ai.sufficit.com.br/api/memory'
capabilities: [search, save, timeline]
credentialRef: 'sufficit/memory-token'
version: 1
---

# sufficit-memory

Tool de memória. Segredo resolvido pelo vault via credentialRef (nunca no arquivo).
`,
    },
    {
        rel: "skills/diff-summary/SKILL.md",
        body: `---
name: diff-summary
description: Resume um diff de git em pontos objetivos.
version: 1
---

# diff-summary

Resuma o diff em bullets: arquivos tocados, intenção, riscos.
`,
    },
    {
        rel: "skills/diff-summary/scripts/run.sh",
        body: `#!/usr/bin/env bash
# Exemplo de script de skill (bundle).
git diff --stat
`,
    },
    {
        rel: "instructions/pt-br-style.md",
        body: `---
name: pt-br-style
description: Responder em português do Brasil, objetivo e técnico.
version: 1
---

# pt-br-style

Responda em pt-BR. Seja objetivo e técnico. Evite redundância.
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
