import * as fs from "fs";
import { mimeTypeFor } from "../parse";
import { ContentPart } from "./types";

export function buildImageParts(images?: string[]): ContentPart[] {
    const imageParts: ContentPart[] = [];
    for (const p of images ?? []) {
        try {
            const mime = mimeTypeFor(p) || "image/png";
            const b64 = fs.readFileSync(p).toString("base64");
            imageParts.push({
                type: "image_url",
                image_url: { url: `data:${mime};base64,${b64}` },
            });
        } catch {
            // skip files we can't read
        }
    }
    return imageParts;
}
