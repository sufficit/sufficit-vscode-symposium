type ShutdownTask = () => Promise<void>;

const shutdownTasks: ShutdownTask[] = [];
const SHUTDOWN_TIMEOUT_MS = 5_000;

export function registerShutdownTask(task: ShutdownTask): void {
    shutdownTasks.push(task);
}

/** VS Code awaits only this promise, so pending async persistence is flushed here. */
export async function deactivate(): Promise<void> {
    const tasks = shutdownTasks.splice(0).map((task) => task().catch(() => undefined));
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, SHUTDOWN_TIMEOUT_MS);
    });
    try {
        await Promise.race([Promise.all(tasks), timeout]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}
