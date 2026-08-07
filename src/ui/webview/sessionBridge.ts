let renderSessionsHandler: () => void = () => undefined;
let backendLabelHandler: (backend: string) => string = (backend) => backend;

export function registerSessionBridge(handlers: {
    renderSessions: () => void;
    backendLabel: (backend: string) => string;
}): void {
    renderSessionsHandler = handlers.renderSessions;
    backendLabelHandler = handlers.backendLabel;
}

export const refreshSessionList = (): void => renderSessionsHandler();
export const sessionBackendName = (backend: string): string => backendLabelHandler(backend);
