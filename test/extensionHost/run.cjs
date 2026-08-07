const { resolve } = require("node:path");
const { runTests } = require("@vscode/test-electron");

async function main() {
    const root = resolve(__dirname, "../..");
    // This command is commonly started from an existing Extension Host, whose
    // environment forces Electron to behave like plain Node. A nested test
    // instance must start as Electron instead.
    delete process.env.ELECTRON_RUN_AS_NODE;
    delete process.env.VSCODE_ESM_ENTRYPOINT;
    delete process.env.VSCODE_CLI;
    await runTests({
        version: "1.100.3",
        extensionDevelopmentPath: root,
        extensionTestsPath: resolve(__dirname, "suite/index.cjs"),
        launchArgs: [
            resolve(__dirname, "workspace"),
            "--disable-gpu",
            "--disable-workspace-trust",
            "--skip-welcome",
            "--skip-release-notes",
        ],
    });
}

main().catch((error) => {
    console.error("Extension Host integration tests failed", error);
    process.exitCode = 1;
});
