/**
 * File-attachment message handlers for the chat surface.
 *
 * Split out of surfaceMessages.ts so that file stays under the 400-line cap.
 * Handles paste-image / drop-file / drop-files / drop-uris: writes the payload
 * to disk and posts the resulting attachments back to the webview. Behavior is
 * identical to the inline case bodies.
 */
import type { WebviewToHost } from "./protocol";
import type { SurfaceMessagesDeps } from "./surfaceMessages";
import { writeDroppedFile, writePastedImage, attachmentFromUri } from "./chatSurfaceContext";

/** Handles paste-image / drop-file / drop-files / drop-uris. Returns true if handled. */
export async function handleFileMessage(message: WebviewToHost, d: SurfaceMessagesDeps): Promise<boolean> {
    switch (message?.type) {
        case "paste-image": {
            const file = await writePastedImage(message.mime, message.data);
            if (file) {
                d.post({ type: "attachments-picked", files: [file] });
            }
            return true;
        }
        case "drop-file": {
            const file = await writeDroppedFile(message.name, message.mime, message.data ?? "");
            if (file) {
                d.post({ type: "attachments-picked", files: [file] });
            }
            return true;
        }
        case "drop-files": {
            const payloads = Array.isArray(message.files) ? message.files : [];
            const written = await Promise.all(
                payloads.map((f: { name?: string; mime?: string; data?: string }) =>
                    writeDroppedFile(f?.name, f?.mime, f?.data ?? "")),
            );
            const files = written.filter((f: { path: string; name: string } | undefined): f is { path: string; name: string } => Boolean(f));
            if (files.length) {
                d.post({ type: "attachments-picked", files });
            }
            return true;
        }
        case "drop-uris": {
            const files = Array.isArray(message.uris)
                ? message.uris.map((u: string) => attachmentFromUri(u)).filter((f: { path: string; name: string } | undefined): f is { path: string; name: string } => Boolean(f))
                : [];
            if (files.length) {
                d.post({ type: "attachments-picked", files });
            }
            return true;
        }
        default:
            return false;
    }
}
