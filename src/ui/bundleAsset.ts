import { readFileSync } from "fs";
import { join } from "path";

/** Reads an asset from compiled tests and from the bundled extension layout. */
export function readBundleAsset(name: string): string {
    try {
        return readFileSync(join(__dirname, name), "utf8");
    } catch {
        return readFileSync(join(__dirname, "ui", name), "utf8");
    }
}
