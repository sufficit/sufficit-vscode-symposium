# Symposium documentation

Start with the [installation and first session](../README.md#quick-start)
instructions. Use the guides below as you configure Symposium or work on the extension.

## Use Symposium

| Task | Guide |
| --- | --- |
| Configure the extension, API, identity, or a CLI executable | [Settings reference](#settings-reference) |
| Resume a conversation after an error | [Session recovery](guides/session-recovery.md) |
| Configure how much history the model receives | [Context and history](guides/context-and-history.md) |
| Set up Genius and troubleshoot authentication | [Genius CLI adapter](guides/genius.md) and [browser authentication](guides/browser-sign-in.md) |
| Access a session from another device | [Remote access](guides/remote-access.md) |

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

- [Settings API](reference/settings-api.md) for reading and changing settings from code.
- [API discovery](reference/api-discovery.md) for clients locating the public interface.
- [Relay protocol](reference/relay-protocol.md) for remote HTTP and AHP WebSocket access.

## Maintain the extension

- [Architecture](../ARCHITECTURE.md) for module boundaries, session lifetime, and transport.
- [Agent Host Protocol](maintainers/agent-host-protocol.md) for the production host, supported channels, and protocol version policy.
- [Webview guidelines](maintainers/webview-ui.md) for theme, focus, and accessibility.
- [Offline config and bridge tests](maintainers/testing.md) for local checks with no live account.
- [Release and publishing](maintainers/release.md), [package versioning](../VERSION.md), and [feature versioning](maintainers/feature-versioning.md).
- [Compression implementation](maintainers/compression.md) for request selection and summary behavior.
- [Pull request evaluations](maintainers/reviews/README.md) for recorded review evidence.
- [Historical assessments](archive/README.md) for dated audits and investigations.

Use lowercase kebab-case for guide, reference, and maintainer filenames.
Use `README.md` for directory indexes. Keep in-app manuals in
`manuals/<locale>/` because the extension opens them by identifier.
Record completed work in `activities/YYYYMMDDHHmm-description.md` and use
`docs/PLAN-*.md` for active execution plans.

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
The checker also enforces the minute-resolution filename for activity records.

[Active release plan](PLAN-TASK-COMPLETION-RELEASE.md).
