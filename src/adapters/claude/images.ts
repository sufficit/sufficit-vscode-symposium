import * as fs from "fs";

/** Reads an image file into an Anthropic base64 image content block. */
export function imageBlock(
    file: string,
): { type: string; source: { type: string; media_type: string; data: string } } | undefined {
    const ext = (file.split(".").pop() || "").toLowerCase();
    const media =
        ext === "jpg" || ext === "jpeg"
            ? "image/jpeg"
            : ext === "gif"
              ? "image/gif"
              : ext === "webp"
                ? "image/webp"
                : ext === "png"
                  ? "image/png"
                  : "";
    if (!media) {
        return undefined;
    }
    try {
        const data = fs.readFileSync(file).toString("base64");
        return { type: "image", source: { type: "base64", media_type: media, data } };
    } catch {
        return undefined;
    }
}
