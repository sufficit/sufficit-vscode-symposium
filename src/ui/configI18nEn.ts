// English strings for the Symposium Configuration panel i18n.
// Split out of configI18n.ts so that file stays under the 400-line cap.
// Keep this dependency-free so it is safe to JSON.stringify into the webview.

import { CONFIG_EN_MESSAGES } from "./configI18nEnMessages";

type Dict = Record<string, string>;

export const CONFIG_EN: Dict = {
    ...CONFIG_EN_MESSAGES,
    "config.title": "Symposium · Configuration",
    "config.header.hubUnknown": "hub: —",
    "config.header.hubPrefix": "hub: ",
    "config.btn.seed": "Seed examples",
    "config.btn.openRoot": "Open folder",
    "config.btn.refresh": "Refresh",
    "config.btn.fetchModels": "List Models",
    "config.loading": "Loading…",
    "config.tab.agents": "Agents",
    "config.tab.skills": "Skills",
    "config.tab.tools": "Tools",
    "config.tab.instructions": "Instructions",
    "config.tab.mcpServers": "MCP Servers",
    "config.tab.backends": "Backends",
    "config.tab.preferences": "Preferences",
    "config.tab.voice": "Voice",
    "config.tab.vscode": "VS Code",
    "config.voice.downloading": "Downloading…",
    "config.voice.badge.available": "available",
    "config.voice.badge.notFound": "not found",
    "config.voice.diagnose.section": "Setup & diagnostic",
    "config.voice.diagnose.hint":
        "Check whether voice input is ready (audio converter, speech engine binary, and a model). Shows what's missing and how to fix it.",
    "config.voice.diagnose.btn": "Run diagnostic",
    "config.voice.diagnose.running": "Checking…",
    "config.voice.diagnose.unavailable": "Speech-to-text state unavailable.",
    "config.voice.diagnose.allOk":
        "Voice input is ready — the microphone button will be available in the chat composer.",
    "config.voice.diagnose.notReady":
        "Voice input is not ready. Fix the items below; the microphone button stays hidden until everything passes.",
    "config.voice.diagnose.ffmpeg": "Audio converter (ffmpeg)",
    "config.voice.diagnose.fixFfmpeg": "Install ffmpeg, e.g.: sudo apt-get install -y ffmpeg",
    "config.voice.diagnose.binary": "{engine} engine binary",
    "config.voice.diagnose.fixBinary":
        "Install the {engine} binary ({hint}) or set symposium.voice.<engine>.binaryPath. Current path: {path}",
    "config.voice.diagnose.model": "{engine} model",
    "config.voice.diagnose.fixModel":
        "Download a model below (use the buttons provided), or pick one in the engine section.",
    "config.voice.diagnose.webspeech": "Browser Web Speech API",
    "config.voice.diagnose.fixWebspeech":
        "This webview does not expose SpeechRecognition. Use code-server with a compatible browser or select a local engine.",
    "config.voice.diagnose.fixWebspeechDesktop":
        "Web Speech's API is present here (Electron), but the recognition service never actually starts in VS Code desktop. Select a local engine (whisper.cpp / faster-whisper / vosk) below instead.",
    "config.voice.diagnose.vscodeSpeech": "Microsoft VS Code Speech provider",
    "config.voice.diagnose.vscodeSpeechReady":
        "Provider installed. The first microphone recording performs the final functional check.",
    "config.voice.diagnose.fixVscodeSpeech":
        "Install and enable ms-vscode.vscode-speech in this VS Code UI.",
    "config.voice.diagnose.fixVscodeSpeechWeb":
        "VS Code Speech requires the desktop VS Code UI and cannot run in a code-server browser session.",
    "config.voice.vscodeSpeech.install": "Install VS Code Speech",
    "config.voice.vscodeSpeech.installing": "Installing provider…",
    "config.voice.vscodeSpeech.installed":
        "Provider installed. Run one microphone recording to validate audio and language.",
    "config.voice.vscodeSpeech.installFailed": "Provider installation failed: {error}",
    "config.voice.diagnose.download": "Download",
    "config.voice.sufficitAutomation.section": "Recovery and benchmark (Sufficit AI)",
    "config.voice.sufficitRecover.hint":
        "If the best engine is already known, restore only that saved setup: repair its dependencies, paths and model, then run one short test without benchmarking again or changing the winner.",
    "config.voice.sufficitRecover.btn": "Restore selected engine",
    "config.voice.sufficitRecover.starting": "Starting recovery…",
    "config.voice.sufficitRecover.started":
        "Recovery started — follow it in the chat panel. Only the selected engine will be repaired and validated.",
    "config.voice.sufficitRecover.failed":
        "Could not start — sign-in or the Sufficit AI backend changed since this panel opened. Reopen Config and try again.",
    "config.voice.sufficitRecover.noWinner":
        "No local winning engine is saved. Select a local engine or run the benchmark once.",
    "config.voice.sufficitDiagnose.hint":
        "Hands this off to a Sufficit AI agent: benchmarks the three WAV-capable local engines and also installs/checks VS Code Speech as an interactive candidate. It never fabricates WAV metrics for the workbench provider.",
    "config.voice.sufficitDiagnose.btn": "Run automated benchmark",
    "config.voice.sufficitDiagnose.starting": "Starting the session…",
    "config.voice.sufficitDiagnose.started":
        "Session started — check the chat panel to follow along. It applies its decision automatically when done.",
    "config.voice.sufficitDiagnose.failed":
        "Could not start — sign-in or the Sufficit AI backend changed since this panel opened. Reopen Config and try again.",
    "config.voice.sufficitDiagnose.needsLogin":
        "Sign in to Sufficit AI in the Sufficit tab to use this — it needs an active Sufficit AI backend session.",
    "config.tab.compaction": "Compaction",
    "config.tab.sync": "Sync",
    "config.tab.sufficit": "Sufficit",
    "config.sufficit.section.auth": "Authentication",
    "config.sufficit.section.memory": "Memory",
    "config.sufficit.section.network": "Network & Remote Access",
    "config.sufficit.section.vault": "Vault",
    "config.sufficit.network.desc":
        "Status of the remote bridge, Sufficit relay tunnel, and Tailscale VPN. Click Show QR Code to enable everything and scan from your phone.",
    "config.sufficit.network.bridge": "Bridge",
    "config.sufficit.network.relay": "Relay URL",
    "config.sufficit.network.vpn": "VPN (Tailscale)",
    "config.sufficit.remote.btn": "Show QR Code",
    "config.sufficit.auth.signedIn": "Signed in as",
    "config.sufficit.auth.notSignedIn": "Not signed in",
    "config.sufficit.auth.noKeyring":
        "This environment has no system keyring available, so your Sufficit login is saved in the extension's local storage instead. It is kept across restarts — it works normally — it is just less isolated than an OS keyring would be.",
    "config.sufficit.memory.desc":
        "Hint injected into the system prompt for logged-in users, guiding them to search Sufficit shared memory before asking you for context. Clear the field to disable injection entirely.",
    "config.sufficit.vault.desc":
        "Tools bound to secrets via credentialRef. Secrets are resolved at runtime through the Sufficit vault (hub API) and injected into the tool's env — never stored on disk.",
    "config.sufficit.vault.empty": "No tools are bound to vault secrets.",
    "config.btn.new.agent": "+ New agent",
    "config.btn.new.skill": "+ New skill",
    "config.btn.new.tool": "+ New tool",
    "config.btn.new.instruction": "+ New instruction",
    "config.kind.agent": "agent",
    "config.kind.skill": "skill",
    "config.kind.tool": "tool",
    "config.kind.instruction": "instruction",
    "config.kind.mcpServer": "MCP server",
    "config.mcpServers.noServers": "No MCP servers configured",
    "config.mcpServers.desc":
        "MCP (Model Context Protocol) servers organize tools, prompts and resources by server.",
    "config.mcpServers.importDesc": "Import MCP servers from Claude or Codex configuration files.",
    "config.mcpServers.builtin": "Native Sufficit AI server (available when logged in)",
    "config.mcpServers.toolsCount": "tools",
    "config.mcpServers.promptsCount": "prompts",
    "config.mcpServers.resourcesCount": "resources",
    "config.btn.importMcpServers": "Import MCP servers…",
    "config.mcpServers.deleteConfirm": "Are you sure you want to remove this MCP server?",
    "config.mcpServers.tools": "Tools",
    "config.mcpServers.prompts": "Prompts",
    "config.mcpServers.resources": "Resources",
    "config.btn.delete": "Delete",
    "config.btn.addMcpServer": "+ New MCP server",
    "config.mcpServers.transport": "Transport",
    "config.mcpServers.command": "Command",
    "config.mcpServers.url": "URL",
    "config.mcpServers.args": "Args",
    "config.mcpServers.env": "Env",
    "config.mcpServers.noItems": "No items discovered yet",
    "config.mcpServers.expandHint": "Show discovered tools, prompts and resources",
};
