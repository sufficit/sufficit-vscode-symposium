let optimisticUserMessageHandler: (clientMessageId: string, text: string) => void = () => undefined;
let endStreamHandler: () => void = () => undefined;
let endToolGroupHandler: () => void = () => undefined;

export function registerMessageBridge(handlers: {
    optimisticUserMessage: (clientMessageId: string, text: string) => void;
    endStream: () => void;
    endToolGroup: () => void;
}): void {
    optimisticUserMessageHandler = handlers.optimisticUserMessage;
    endStreamHandler = handlers.endStream;
    endToolGroupHandler = handlers.endToolGroup;
}

export const addOptimisticUserMessage = (clientMessageId: string, text: string): void =>
    optimisticUserMessageHandler(clientMessageId, text);
export const endMessageStream = (): void => endStreamHandler();
export const endMessageToolGroup = (): void => endToolGroupHandler();
