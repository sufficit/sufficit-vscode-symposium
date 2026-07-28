import * as path from "node:path";

/**
 * Host-level write-root guardrail (delivery 1E).
 *
 * Containment logic for the agent's mutating tools: when `allowedWriteRoots` is
 * set (non-empty), write_file/edit_file targets and shell cwd must resolve
 * inside one of the roots. A mutation targeting a path outside any root is
 * blocked by the host (not the prompt), preventing the agent from writing
 * across repo boundaries or into files outside the authorized workspace.
 *
 * Extracted into a vscode-free module so the pure containment logic unit-tests
 * under `node --test` without pulling the VS Code runtime.
 */

/**
 * True when `target` resolves inside one of the allowed write roots. When
 * `roots` is empty/undefined the check is bypassed (preserves the unrestricted
 * default for backends that don't scope writes). Proper path-boundary check
 * (no prefix bug): `/foo` does not match root `/fo`. Mirrors bridgePolicy.ts's
 * isCwdAllowed.
 */
export function isPathInAllowedRoots(target: string, roots?: string[]): boolean {
    if (!roots || roots.length === 0) { return true; }   // no containment configured
    const t = path.resolve(target);
    return roots.some((root) => {
        const r = path.resolve(root);
        return t === r || t.startsWith(r + path.sep);
    });
}

/**
 * Returns a guardrail error string when the target is outside the allowed roots,
 * or undefined when it's allowed. Used at the top of write_file/edit_file/shell.
 */
export function writeRootError(target: string, allowedWriteRoots?: string[]): string | undefined {
    if (!isPathInAllowedRoots(target, allowedWriteRoots)) {
        const roots = (allowedWriteRoots ?? []).map((r) => path.resolve(r)).join(", ");
        return `Write-root guardrail: "${target}" is outside the authorized workspace roots [${roots}]. Writing outside the workspace is blocked by the host. If this is intentional, ask the user to open the target folder as a workspace root.`;
    }
    return undefined;
}
