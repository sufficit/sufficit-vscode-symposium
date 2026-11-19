# Symposium documentation

Start with the [installation and first session](../README.md#quick-start)
instructions. Use the guides below as you configure Symposium or work on the extension.

## Use Symposium

| Task | Guide |
| --- | --- |
| Configure the extension, API, identity, or a CLI executable | [Settings reference](#settings-reference) |
| Resume a conversation after an error | [Session recovery](SESSION-RECOVERY.md) |
| Configure how much history the model receives | [Context and history](CONTEXT-HISTORY.md) |
| Set up Genius and troubleshoot authentication | [Genius CLI adapter](GENIUS-CLI-ADAPTER.md) and [browser authentication](DEVICE-FLOW-BROWSER.md) |
| Access a session from another device | [Remote access](REMOTE-ACCESS.md) |
| Configure compression | [Compression guide](compression-guide.md) and [preset reference](compression-presets.md) |

Manuals are available in English and Brazilian Portuguese.

| Manual | English | Português (Brasil) |
| --- | --- | --- |
| Compression | [Manual](manuals/en/compression.md) | [Manual](manuals/pt-br/compression.md) |
| OpenAI-compatible history diagnostics | [Manual](manuals/en/openai-history.md) | [Manual](manuals/pt-br/openai-history.md) |

### Settings reference

Search for **Symposium** in VS Code settings. [The extension manifest](../package.json)
lists the full settings schema and defaults.

| Setting | Purpose |
| --- | --- |
| `symposium.openai.baseUrl` | OpenAI-compatible API URL. Default is `https://ai.sufficit.com.br/openai/v1`. |
| `symposium.identity.url` | Sufficit Identity issuer. Default is `https://identity.sufficit.com.br`. |
| `symposium.identity.scope` | OAuth scopes requested at login. Symposium includes `roles` and `entitlements` for Sufficit AI authorization. |
| `symposium.hub.url` | Memory and vault hub URL. An empty value disables hub synchronization. |
| `symposium.claude.executable`, `symposium.codex.executable`, `symposium.genius.executable`, `symposium.copilot.executable` | CLI executable paths on the extension host. |
| `symposium.claude.model`, `symposium.codex.model`, `symposium.genius.model`, `symposium.copilot.model` | Default models for CLI sessions. |
| `symposium.claude.permissionMode` | Default Claude permission mode for new sessions. |

## Integrate with Symposium

- [Settings API](USAGE-api-settings.md) for reading and changing settings from code.
- [API discovery](API-DISCOVERY.md) for clients locating the public interface.
- [Relay protocol](RELAY-PROTOCOL.md) for remote HTTP and AHP WebSocket access.

## Maintain the extension

- [Architecture](../ARCHITECTURE.md) for module boundaries, session lifetime, and transport.
- [Agent Host Protocol](AHP-ADOPTION.md) for the production host, supported channels, and protocol version policy.
- [Webview guidelines](USAGE-guidelines-ui.md) for theme, focus, and accessibility.
- [Offline config and bridge tests](TESTING-config-and-bridge.md) for local checks with no live account.
- [Release and publishing](RELEASE.md), [package versioning](../VERSION.md), and [feature versioning](FEATURE-VERSIONING.md).
- [Pull request evaluations](pullrequests/README.md) for recorded review evidence.

### Markdown reference checks

Run this command from the repository before committing documentation changes.

```bash
npm run check:markdown
```

The [checker](../scripts/check-markdown-coverage.mjs) starts at the root README.
It verifies that tracked and new Markdown documents are reachable through links
and that repository-local links to Markdown files point to existing files.
It recognizes inline links, reference-style links, HTML anchors, and directory
links whose target contains a README. It skips external URLs and does not check
heading fragments or links to non-Markdown assets. The check also runs through
`npm test` and `npm run verify` in CI.

When adding a guide, link to it from the nearest guide or index. When moving or
renaming a file, update both links to the file and relative links inside it.
Use [the ignore list](../.markdown-coverage-ignore) for archived records. Direct
links from maintained guides to those records still have their targets checked.
