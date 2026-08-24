const Module = require("node:module");

const configuration = {
    get(_key, fallback) {
        return fallback;
    },
    inspect() {
        return undefined;
    },
    update() {
        return Promise.resolve();
    },
};

const disposable = () => ({ dispose() {} });
const vscodeStub = {
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    Disposable: class {
        dispose() {}
    },
    EventEmitter: class {
        event = () => disposable();
        fire() {}
        dispose() {}
    },
    Uri: {
        file(fsPath) {
            return { fsPath, path: fsPath, scheme: "file", toString: () => `file://${fsPath}` };
        },
        parse(value) {
            return { fsPath: value, path: value, scheme: value.split(":")[0], toString: () => value };
        },
    },
    workspace: {
        getConfiguration() {
            return configuration;
        },
        workspaceFolders: [],
        onDidChangeConfiguration: disposable,
        onDidChangeWorkspaceFolders: disposable,
    },
    window: {
        activeTextEditor: undefined,
        terminals: [],
        tabGroups: { all: [] },
        createOutputChannel() {
            return { append() {}, appendLine() {}, clear() {}, show() {}, dispose() {} };
        },
        onDidChangeActiveTerminal: disposable,
        onDidCloseTerminal: disposable,
    },
    commands: { executeCommand: async () => undefined, registerCommand: disposable },
    env: { remoteName: undefined, machineId: "test-machine", sessionId: "test-session" },
};

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
    if (request === "vscode") {
        return vscodeStub;
    }
    return originalLoad.call(this, request, parent, isMain);
};
