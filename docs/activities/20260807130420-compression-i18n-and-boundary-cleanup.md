# Activity — compression, i18n and simple boundary cleanup

**Status:** complete
**Implemented:** 2026-08-07 in commit `df00642`

## Outcome

The compression configuration uses one canonical manifest contract, English
configuration text is no longer contaminated by Portuguese, and the largest
avoidable UI/composition-root cycle was removed.

## Implemented scope

- Replaced the undeclared compression key `defaultPreset` with
  `defaultPresetId`.
- Declared `perSessionEnabled` and `sectionConfigs` in the manifest.
- Replaced the nonexistent `builtin-standard` fallback with `none`.
- Restored exact EN/PT-BR key parity and translated five Ollama messages.
- Injected session-cache statistics into the configuration panel.
- Replaced UI imports of `extension.ts` with leaf dependencies.
- Changed handler imports from broad barrels to focused type contracts.
- Removed obsolete duplicate compression modules and the tracked manager backup.

## Validation

The engineering and architecture checks, all tests and the production bundle
passed after the cleanup.
