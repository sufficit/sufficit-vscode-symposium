"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
const vscode = __importStar(require("vscode"));
const OPEN_PANEL_COMMAND = 'sufficit.chatVoice.openPanel';
const INSERT_TRANSCRIPT_COMMAND = 'sufficit.chatVoice.insertTranscript';
const STATUS_BAR_ID = 'sufficit.chatVoice.statusBar';
const DEFAULT_LOCALE = 'pt-BR';
const VIEW_TYPE = 'sufficit.chatVoice.panel';
const CHAT_OPEN_COMMAND = 'workbench.action.chat.open';
const CHAT_OPEN_FALLBACK_COMMAND = 'workbench.action.openChat';
const STATUS_BAR_PRIORITY = 10;
const PANEL_COLUMN = vscode.ViewColumn.Beside;
let currentPanel;
function activate(context) {
    const statusBarItem = vscode.window.createStatusBarItem(STATUS_BAR_ID, vscode.StatusBarAlignment.Right, STATUS_BAR_PRIORITY);
    statusBarItem.text = '$(mic) Voz Chat';
    statusBarItem.tooltip = 'Open Brazilian Portuguese voice capture for chat';
    statusBarItem.command = OPEN_PANEL_COMMAND;
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);
    context.subscriptions.push(vscode.commands.registerCommand(OPEN_PANEL_COMMAND, async () => {
        const panel = getOrCreatePanel(context.extensionUri);
        await revealAndConfigurePanel(panel);
    }));
}
function getOrCreatePanel(_extensionUri) {
    if (currentPanel) {
        return currentPanel;
    }
    currentPanel = vscode.window.createWebviewPanel(VIEW_TYPE, 'Chat Voice PT-BR', PANEL_COLUMN, {
        enableScripts: true,
        retainContextWhenHidden: true,
    });
    currentPanel.onDidDispose(() => {
        currentPanel = undefined;
    });
    currentPanel.webview.onDidReceiveMessage(async (message) => {
        switch (message.type) {
            case 'ready':
                await postSettingsToPanel(currentPanel);
                break;
            case 'insertTranscript':
                await insertTranscriptIntoChat(message.transcript);
                await closePanelAfterInsertIfNeeded();
                break;
            case 'copyTranscript':
                await vscode.env.clipboard.writeText(message.transcript.trim());
                void vscode.window.showInformationMessage('Transcript copied to clipboard.');
                break;
            case 'showError':
                void vscode.window.showErrorMessage(message.message);
                break;
            default:
                break;
        }
    });
    currentPanel.webview.html = getWebviewHtml(currentPanel.webview);
    return currentPanel;
}
async function revealAndConfigurePanel(panel) {
    panel.reveal(PANEL_COLUMN, true);
    await postSettingsToPanel(panel);
}
async function postSettingsToPanel(panel) {
    if (!panel) {
        return;
    }
    const settings = getSettings();
    await panel.webview.postMessage({
        type: 'settings',
        locale: settings.locale,
        sendImmediately: settings.sendImmediately,
        keepPanelOpen: settings.keepPanelOpen,
    });
}
async function insertTranscriptIntoChat(rawTranscript) {
    const transcript = rawTranscript.trim();
    if (!transcript) {
        void vscode.window.showWarningMessage('No transcript available to insert into chat.');
        return;
    }
    const settings = getSettings();
    const chatOptions = {
        query: transcript,
        isPartialQuery: !settings.sendImmediately,
    };
    try {
        await vscode.commands.executeCommand(CHAT_OPEN_COMMAND, chatOptions);
    }
    catch {
        await vscode.commands.executeCommand(CHAT_OPEN_FALLBACK_COMMAND);
        await vscode.commands.executeCommand(CHAT_OPEN_COMMAND, chatOptions);
    }
}
async function closePanelAfterInsertIfNeeded() {
    const settings = getSettings();
    if (!settings.keepPanelOpen) {
        currentPanel?.dispose();
    }
}
function getSettings() {
    const configuration = vscode.workspace.getConfiguration('sufficitChatVoice');
    const locale = configuration.get('locale', DEFAULT_LOCALE).trim() || DEFAULT_LOCALE;
    const sendImmediately = configuration.get('sendImmediately', false);
    const keepPanelOpen = configuration.get('keepPanelOpen', true);
    return { locale, sendImmediately, keepPanelOpen };
}
function getWebviewHtml(webview) {
    const nonce = createNonce();
    const csp = [
        "default-src 'none'",
        `style-src ${webview.cspSource} 'unsafe-inline'`,
        `script-src 'nonce-${nonce}'`,
        "img-src data:",
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8" />
	<meta http-equiv="Content-Security-Policy" content="${csp}" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<title>Chat Voice PT-BR</title>
	<style>
		:root {
			color-scheme: light dark;
		}
		body {
			font-family: var(--vscode-font-family);
			padding: 16px;
			color: var(--vscode-foreground);
			background: var(--vscode-editor-background);
		}
		.container {
			display: flex;
			flex-direction: column;
			gap: 12px;
		}
		.actions {
			display: flex;
			gap: 8px;
			flex-wrap: wrap;
		}
		button {
			border: none;
			padding: 8px 12px;
			cursor: pointer;
			border-radius: 6px;
			color: var(--vscode-button-foreground);
			background: var(--vscode-button-background);
		}
		button.secondary {
			color: var(--vscode-button-secondaryForeground);
			background: var(--vscode-button-secondaryBackground);
		}
		button:disabled {
			opacity: 0.6;
			cursor: default;
		}
		textarea {
			width: 100%;
			min-height: 180px;
			resize: vertical;
			padding: 10px;
			box-sizing: border-box;
			border-radius: 6px;
			border: 1px solid var(--vscode-input-border);
			color: var(--vscode-input-foreground);
			background: var(--vscode-input-background);
		}
		.small {
			font-size: 12px;
			opacity: 0.85;
		}
		.badge {
			display: inline-flex;
			align-items: center;
			padding: 2px 8px;
			border-radius: 999px;
			background: var(--vscode-badge-background);
			color: var(--vscode-badge-foreground);
			width: fit-content;
		}
		ul {
			margin: 0;
			padding-left: 18px;
		}
	</style>
</head>
<body>
	<div class="container">
		<h2>Chat Voice PT-BR</h2>
		<div id="status" class="badge">Initializing...</div>
		<div class="small">Use browser speech recognition to capture voice and prefill the chat input.</div>
		<div class="actions">
			<button id="startButton">Start recording</button>
			<button id="stopButton" class="secondary" disabled>Stop</button>
			<button id="insertButton" disabled>Insert into chat</button>
			<button id="copyButton" class="secondary" disabled>Copy text</button>
			<button id="clearButton" class="secondary">Clear</button>
		</div>
		<label for="transcript">Transcript</label>
		<textarea id="transcript" placeholder="Your transcript will appear here..."></textarea>
		<div class="small">
			<ul>
				<li>Locale: <span id="localeValue">pt-BR</span></li>
				<li>The extension uses the public chat open command, so it prefills the current chat instead of controlling the native microphone UI.</li>
				<li>If browser speech recognition is unavailable, use a Chromium-based browser or another environment that exposes Web Speech API.</li>
			</ul>
		</div>
	</div>

	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const transcriptElement = document.getElementById('transcript');
		const statusElement = document.getElementById('status');
		const localeValueElement = document.getElementById('localeValue');
		const startButton = document.getElementById('startButton');
		const stopButton = document.getElementById('stopButton');
		const insertButton = document.getElementById('insertButton');
		const copyButton = document.getElementById('copyButton');
		const clearButton = document.getElementById('clearButton');
		const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
		let recognition;
		let isRecording = false;
		let locale = 'pt-BR';

		function setStatus(message) {
			statusElement.textContent = message;
		}

		function syncButtons() {
			const hasText = transcriptElement.value.trim().length > 0;
			startButton.disabled = !SpeechRecognitionCtor || isRecording;
			stopButton.disabled = !SpeechRecognitionCtor || !isRecording;
			insertButton.disabled = !hasText;
			copyButton.disabled = !hasText;
		}

		function ensureRecognition() {
			if (!SpeechRecognitionCtor) {
				setStatus('Speech recognition unavailable in this browser.');
				vscode.postMessage({
					type: 'showError',
					message: 'SpeechRecognition is not available in this browser context.',
				});
				syncButtons();
				return false;
			}

			if (!recognition) {
				recognition = new SpeechRecognitionCtor();
				recognition.lang = locale;
				recognition.interimResults = true;
				recognition.continuous = true;

				recognition.onstart = () => {
					isRecording = true;
					setStatus('Listening...');
					syncButtons();
				};

				recognition.onend = () => {
					isRecording = false;
					setStatus('Stopped.');
					syncButtons();
				};

				recognition.onerror = (event) => {
					isRecording = false;
					setStatus('Recognition error: ' + event.error);
					syncButtons();
				};

				recognition.onresult = (event) => {
					let finalText = '';
					let interimText = '';
					for (let index = event.resultIndex; index < event.results.length; index += 1) {
						const result = event.results[index];
						const text = result[0] ? result[0].transcript : '';
						if (result.isFinal) {
							finalText += text + ' ';
						} else {
							interimText += text + ' ';
						}
					}

					const committed = transcriptElement.dataset.committed || '';
					const updatedCommitted = (committed + finalText).trim();
					transcriptElement.dataset.committed = updatedCommitted ? updatedCommitted + ' ' : '';
					transcriptElement.value = (updatedCommitted + ' ' + interimText).trim();
					setStatus(interimText ? 'Listening and transcribing...' : 'Transcript updated.');
					syncButtons();
				};
			}

			recognition.lang = locale;
			return true;
		}

		startButton.addEventListener('click', () => {
			if (!ensureRecognition()) {
				return;
			}
			try {
				recognition.start();
			} catch (error) {
				setStatus('Unable to start recording.');
			}
		});

		stopButton.addEventListener('click', () => {
			if (recognition && isRecording) {
				recognition.stop();
			}
		});

		insertButton.addEventListener('click', () => {
			vscode.postMessage({
				type: 'insertTranscript',
				transcript: transcriptElement.value,
			});
			setStatus('Transcript sent to chat.');
		});

		copyButton.addEventListener('click', () => {
			vscode.postMessage({
				type: 'copyTranscript',
				transcript: transcriptElement.value,
			});
			setStatus('Transcript copied.');
		});

		clearButton.addEventListener('click', () => {
			transcriptElement.value = '';
			transcriptElement.dataset.committed = '';
			setStatus('Transcript cleared.');
			syncButtons();
		});

		window.addEventListener('message', (event) => {
			const message = event.data;
			if (!message || message.type !== 'settings') {
				return;
			}

			locale = message.locale || 'pt-BR';
			localeValueElement.textContent = locale;
			if (recognition) {
				recognition.lang = locale;
			}
			setStatus(SpeechRecognitionCtor ? 'Ready.' : 'Speech recognition unavailable in this browser.');
			syncButtons();
		});

		transcriptElement.addEventListener('input', syncButtons);
		syncButtons();
		vscode.postMessage({ type: 'ready' });
	</script>
</body>
</html>`;
}
function createNonce() {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let value = '';
    for (let index = 0; index < 32; index += 1) {
        value += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
    }
    return value;
}
//# sourceMappingURL=extension.js.map