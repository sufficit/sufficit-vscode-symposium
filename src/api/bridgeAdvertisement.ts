import * as fs from "fs";
import * as os from "os";
import * as path from "path";

function advertisementPath(): string {
    return path.join(os.homedir(), ".symposium", "bridge.json");
}

export function writeBridgeAdvertisement(url: string, token: string): void {
    const filePath = advertisementPath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ url, token }), { mode: 0o600 });
}

export function removeBridgeAdvertisement(): void {
    try {
        fs.rmSync(advertisementPath(), { force: true });
    } catch {
        /* ignore */
    }
}
