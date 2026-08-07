export interface StatePort {
    get<T>(key: string, fallback: T): T;
    update(key: string, value: unknown): Promise<void>;
}

export interface SecretPort {
    get(key: string): Promise<string | undefined>;
    store(key: string, value: string): Promise<void>;
    delete(key: string): Promise<void>;
}

export interface ProcessResult {
    exitCode: number;
    stdout: string;
    stderr: string;
}

export interface ProcessPort {
    run(command: string, args: readonly string[], cwd?: string): Promise<ProcessResult>;
}

export interface ClockPort {
    now(): number;
    setTimeout(callback: () => void, milliseconds: number): ReturnType<typeof setTimeout>;
    clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

export interface ConfigurationPort {
    get<T>(section: string, key: string, fallback: T): T;
    readonly language: string;
}

export interface FileDialogPort {
    pickFiles(options: {
        many: boolean;
        label: string;
        title: string;
    }): Promise<Array<{ path: string; name: string }>>;
}

export interface IdPort {
    create(): string;
}

export interface ApplicationPorts {
    state: StatePort;
    secrets: SecretPort;
    process: ProcessPort;
    clock: ClockPort;
    configuration: ConfigurationPort;
    files: FileDialogPort;
    ids: IdPort;
}
