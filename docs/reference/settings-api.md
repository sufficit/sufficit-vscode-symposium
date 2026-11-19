# Settings API

Other VS Code extensions can access Symposium settings through the API exposed
by `sufficit.sufficit-vscode-symposium`. Keys use their full names from
[the extension manifest](../../package.json).

```ts
import * as vscode from "vscode";

const extension = vscode.extensions.getExtension("sufficit.sufficit-vscode-symposium");
if (!extension) throw new Error("Symposium is not installed");

const { settings } = await extension.activate();
const previous = await settings.get("symposium.chat.preferredLanguage");
await settings.set("symposium.chat.preferredLanguage", "pt-br", "workspace");
await settings.delete("symposium.chat.preferredLanguage", "workspace");
```

| Method | Result |
| --- | --- |
| `get(key)` | The effective VS Code configuration value, including a default when one exists. |
| `getAll()` | A flat map of effective values for keys discovered in the configured global and workspace overrides. Use the manifest for a complete schema. |
| `set(key, value, target?)` | Updates the setting and resolves to `true` after VS Code accepts the update. |
| `delete(key, target?)` | Removes the override at that scope. Other scopes and defaults can still supply a value. |

Write operations default to `global`. Specify `workspace` to modify the
workspace configuration. A rejected VS Code configuration update rejects the
promise. Read the effective value with `get` to verify the outcome.

See the [Settings API implementation](../../src/api/settingsApi.ts) and
[feature discovery](api-discovery.md) for version negotiation.
