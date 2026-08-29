import * as os from "node:os";
import * as path from "node:path";
import { JsonlAdapterUsage } from "../quotaCache";

/** Account-usage provider for Gemini/Antigravity transcripts. */
export const geminiUsage = new JsonlAdapterUsage("gemini", "Gemini", () => [
    path.join(os.homedir(), ".gemini", "antigravity-ide", "brain"),
    path.join(os.homedir(), ".gemini", "history"),
]);
