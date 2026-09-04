import assert from "node:assert/strict";
import test from "node:test";
import { pickImageType } from "../ui/chatSurfaceContext";

test("clipboard target list prefers png over other offered image types", () => {
    assert.equal(pickImageType(["text/plain", "image/jpeg", "image/png", "TARGETS"]), "image/png");
});

test("clipboard target list falls back to the next supported raster type", () => {
    assert.equal(pickImageType(["text/html", "image/webp"]), "image/webp");
});

test("clipboard target list accepts an unlisted image type before svg", () => {
    assert.equal(pickImageType(["image/svg+xml", "image/tiff"]), "image/tiff");
});

test("clipboard target list uses svg only as a last resort", () => {
    assert.equal(pickImageType(["text/plain", "image/svg+xml"]), "image/svg+xml");
});

test("clipboard target list without an image yields no type", () => {
    assert.equal(pickImageType(["text/plain", "text/uri-list", "", "  "]), undefined);
});

test("clipboard target list tolerates padded tool output", () => {
    assert.equal(pickImageType([" image/png ", "text/plain "]), "image/png");
});
