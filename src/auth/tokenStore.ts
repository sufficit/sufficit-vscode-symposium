import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import type * as vscode from "vscode";

const TOKEN_FILE = "identity-fallback.json";
const INITIALIZED_FILE = "identity-shared-store-v1";
const LOCK_FILE = "identity-fallback.lock";

export interface TokenStoreLockOptions {
    timeoutMs?: number;
    staleMs?: number;
    retryMs?: number;
}

function delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * File-backed Identity token store shared by every browser connected to the
 * same code-server OS user. Files are private to that user and token updates
 * are atomic, so readers never observe truncated JSON.
 */
export class SharedIdentityTokenStore {
    private readonly tokenFile: string;
    private readonly initializedFile: string;
    private readonly lockFile: string;

    constructor(private readonly directory: string) {
        this.tokenFile = path.join(directory, TOKEN_FILE);
        this.initializedFile = path.join(directory, INITIALIZED_FILE);
        this.lockFile = path.join(directory, LOCK_FILE);
    }

    read(): string | undefined {
        try {
            const raw = fs.readFileSync(this.tokenFile, "utf8");
            return raw || undefined;
        } catch {
            return undefined;
        }
    }

    isInitialized(): boolean {
        return fs.existsSync(this.initializedFile);
    }

    /**
     * Marks the shared store as authoritative. The marker intentionally
     * survives logout, preventing another browser's stale SecretStorage from
     * restoring a session that was explicitly removed elsewhere.
     */
    initialize(): void {
        this.ensureDirectory();
        try { fs.chmodSync(this.tokenFile, 0o600); } catch { /* token may not exist yet */ }
        if (!this.isInitialized()) {
            this.atomicWrite(this.initializedFile, "1\n");
        }
    }

    write(payload: string | undefined): void {
        this.initialize();
        if (payload === undefined) {
            this.removeToken();
            return;
        }
        this.atomicWrite(this.tokenFile, payload);
    }

    removeToken(): void {
        fs.rmSync(this.tokenFile, { force: true });
    }

    watch(listener: () => void): fs.FSWatcher | undefined {
        try {
            this.ensureDirectory();
            return fs.watch(this.directory, (_event, filename) => {
                if (filename?.toString() === TOKEN_FILE) {
                    listener();
                }
            });
        } catch {
            return undefined;
        }
    }

    async withLock<T>(action: () => Promise<T> | T, options: TokenStoreLockOptions = {}): Promise<T> {
        const timeoutMs = options.timeoutMs ?? 30_000;
        const staleMs = options.staleMs ?? 120_000;
        const retryMs = options.retryMs ?? 40;
        const deadline = Date.now() + timeoutMs;
        const owner = `${process.pid}:${Date.now()}:${randomUUID()}`;

        this.ensureDirectory();
        while (true) {
            try {
                const descriptor = fs.openSync(this.lockFile, "wx", 0o600);
                try {
                    fs.writeFileSync(descriptor, owner, "utf8");
                } finally {
                    fs.closeSync(descriptor);
                }
                break;
            } catch (error) {
                const code = (error as NodeJS.ErrnoException).code;
                if (code !== "EEXIST") {
                    throw error;
                }
                try {
                    const ageMs = Date.now() - fs.statSync(this.lockFile).mtimeMs;
                    if (ageMs > staleMs) {
                        fs.rmSync(this.lockFile, { force: true });
                        continue;
                    }
                } catch {
                    continue;
                }
                if (Date.now() >= deadline) {
                    throw new Error(`Timed out waiting for the shared Identity token lock (${timeoutMs}ms).`);
                }
                await delay(retryMs);
            }
        }

        try {
            return await action();
        } finally {
            try {
                if (fs.readFileSync(this.lockFile, "utf8") === owner) {
                    fs.rmSync(this.lockFile, { force: true });
                }
            } catch {
                // A stale-lock recovery may already have removed it.
            }
        }
    }

    private ensureDirectory(): void {
        fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    }

    private atomicWrite(file: string, payload: string): void {
        const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
        try {
            fs.writeFileSync(temporary, payload, { encoding: "utf8", flag: "wx", mode: 0o600 });
            fs.renameSync(temporary, file);
            fs.chmodSync(file, 0o600);
        } finally {
            fs.rmSync(temporary, { force: true });
        }
    }
}

export function sharedIdentityTokenStore(context: vscode.ExtensionContext): SharedIdentityTokenStore {
    return new SharedIdentityTokenStore(context.globalStorageUri.fsPath);
}
