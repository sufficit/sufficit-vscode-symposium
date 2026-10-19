import { Worker } from "node:worker_threads";

const JSON_PARSE_WORKER = `
const { parentPort, workerData } = require("node:worker_threads");
try {
  const text = Buffer.from(workerData).toString("utf8");
  parentPort.postMessage({ ok: true, value: JSON.parse(text) });
} catch (error) {
  parentPort.postMessage({ ok: false, message: error instanceof Error ? error.message : String(error) });
} finally {
  parentPort.close();
}
`;
const WORKER_THRESHOLD_BYTES = 1024 * 1024;

/** Parse large persisted JSON off the Extension Host event loop. */
export async function parsePersistedJson(contents: Buffer): Promise<unknown> {
    if (contents.byteLength < WORKER_THRESHOLD_BYTES) {
        return JSON.parse(contents.toString("utf8")) as unknown;
    }
    // `readFile` returns a standalone buffer for these sizes. Transfer its
    // backing store instead of copying a second 20 MB string into workerData.
    const source = contents.buffer;
    const transferable =
        source instanceof ArrayBuffer &&
        contents.byteOffset === 0 &&
        contents.byteLength === source.byteLength
            ? source
            : Uint8Array.from(contents).buffer;
    const worker = new Worker(JSON_PARSE_WORKER, {
        eval: true,
        workerData: transferable,
        transferList: [transferable],
    });
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error, value?: unknown) => {
            if (settled) return;
            settled = true;
            void worker.terminate();
            if (error) reject(error);
            else resolve(value);
        };
        worker.once("message", (message: { ok: boolean; value?: unknown; message?: string }) => {
            if (message.ok) finish(undefined, message.value);
            else finish(new SyntaxError(message.message ?? "Invalid persisted JSON"));
        });
        worker.once("error", (error) => finish(error));
        worker.once("exit", (code) => {
            if (!settled) finish(new Error(`JSON parser worker exited with code ${code}`));
        });
    });
}
