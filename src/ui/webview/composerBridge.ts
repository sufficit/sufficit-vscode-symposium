type LastUserRow = { idx: number; text: string } | null;

let beginEditHandler: (idx: number, text: string) => void = () => undefined;
let lastUserRowHandler: () => LastUserRow = () => null;
let renderChipsHandler: () => void = () => undefined;
let setSpeechInputHandler: (value: boolean) => void = () => undefined;

export function registerComposerBridge(handlers: {
    beginEdit: (idx: number, text: string) => void;
    lastUserRow: () => LastUserRow;
    renderChips: () => void;
    setSpeechInput: (value: boolean) => void;
}): void {
    beginEditHandler = handlers.beginEdit;
    lastUserRowHandler = handlers.lastUserRow;
    renderChipsHandler = handlers.renderChips;
    setSpeechInputHandler = handlers.setSpeechInput;
}

export const beginComposerEdit = (idx: number, text: string): void => beginEditHandler(idx, text);
export const lastComposerUserRow = (): LastUserRow => lastUserRowHandler();
export const renderComposerChips = (): void => renderChipsHandler();
export const markComposerSpeechInput = (value: boolean): void => setSpeechInputHandler(value);
