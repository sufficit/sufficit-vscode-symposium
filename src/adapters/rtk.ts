import { spawn } from "node:child_process";

/**
 * Availability probe for the `rtk` (Rust Token Killer) wrapper. The RTK preamble
 * is only worth its tokens when rtk is actually callable in the tool shell, so we
 * probe once with `command -v rtk` in the same login shell the tools use, cache
 * the result, and gate the preamble on it. Re-probeable from the tools menu.
 */

let cached: boolean | undefined;
let inFlight: Promise<boolean> | undefined;

/** Last probed result; false until the first probe resolves. */
export function rtkCached(): boolean {
    return cached ?? false;
}

/**
 * Probe rtk availability via `bash -lc 'command -v rtk'` (matches how the shell
 * tool resolves binaries, incl. profile PATH additions like ~/.local/bin).
 * Cached; pass force to re-run (e.g. after the user installs rtk).
 */
export function probeRtk(cwd?: string, force = false): Promise<boolean> {
    if (!force && cached !== undefined) {
        return Promise.resolve(cached);
    }
    if (inFlight) {
        return inFlight;
    }
    inFlight = new Promise<boolean>((resolve) => {
        try {
            const child = spawn("bash", ["-lc", "command -v rtk >/dev/null 2>&1"], { cwd, stdio: "ignore" });
            child.on("error", () => resolve(false));
            child.on("exit", (code) => resolve(code === 0));
        } catch {
            resolve(false);
        }
    }).then((value) => {
        cached = value;
        inFlight = undefined;
        return value;
    });
    return inFlight;
}
