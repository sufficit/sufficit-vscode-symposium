import { existsSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

const providerCommands =
  process.platform === "linux"
    ? ["pw-record", "ffmpeg", "arecord"]
    : process.platform === "darwin"
      ? ["ffmpeg"]
      : process.platform === "win32"
        ? ["ffmpeg.exe", "ffmpeg"]
        : [];

function resolveExecutable(command) {
  if (isAbsolute(command)) return existsSync(command) ? command : undefined;
  for (const directory of (process.env.PATH || "").split(delimiter).filter(Boolean)) {
    const candidate = join(directory, command);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

const available = providerCommands
  .map((command) => ({ command, path: resolveExecutable(command) }))
  .filter((provider) => provider.path);

console.log(`Voice provider smoke (${process.platform}):`);
for (const provider of available) console.log(`  ✓ ${provider.command}: ${provider.path}`);
if (!available.length) {
  console.error(`  ✗ none of ${providerCommands.join(", ")} is available`);
  process.exitCode = 1;
}
