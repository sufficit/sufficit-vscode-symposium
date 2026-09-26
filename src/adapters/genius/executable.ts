import * as fs from "node:fs";
import * as path from "node:path";
import { resolveExecutable } from "../exec";

const windowsService = "Sufficit.AI.Genius.Service.exe";

/** The Windows installer exposes a .cmd wrapper; spawn its native CLI executable. */
export function resolveGeniusExecutable(
    name: string,
    platform = process.platform,
    env: NodeJS.ProcessEnv = process.env,
): string {
    if (platform !== "win32") return resolveExecutable(name);

    const wrapper = /(?:^|[\\/])genius\.cmd$/i.test(name);
    const bare = name.toLowerCase() === "genius" || name.toLowerCase() === "genius.cmd";
    if (!bare && !wrapper) return resolveExecutable(name);

    const directories = bare
        ? [
              ...(env.PATH ?? "").split(";"),
              env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Programs", "SufficitAIGenius"),
          ]
        : [path.dirname(name)];
    for (const directory of directories) {
        if (!directory) continue;
        const executable = path.join(directory, "service", windowsService);
        if (fs.existsSync(executable)) return executable;
    }
    return resolveExecutable(name);
}
