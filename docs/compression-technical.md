# Compression System - Technical Documentation

## Overview

The Compression system in Symposium allows intelligent management of chat history to optimize token usage while maintaining relevant context. This document describes the technical implementation and architecture.

## Core Components

### CompressionManager (`src/compression.ts`)

Singleton class that manages compression presets and configuration.

```typescript
class CompressionManager {
  private static instance: CompressionManager;
  private presets: Map<string, CompressionPreset>;
  private config: CompressionConfig;
  
  static getInstance(): CompressionManager
  listPresets(): CompressionPreset[]
  getPreset(id: string): CompressionPreset | undefined
  createPreset(preset: CompressionPreset): void
  updatePreset(id: string, preset: Partial<CompressionPreset>): void
  deletePreset(id: string): void
  setDefaultPreset(id: string): void
  getDefaultPreset(): CompressionPreset
}
```

### Data Structures

#### CompressionPreset
```typescript
interface CompressionPreset {
  id: string;                    // Unique identifier
  name: string;                  // Display name
  description?: string;          // Optional description
  strategy: CompressionStrategyType;  // Strategy type
  params: CompressionParams;     // Strategy-specific parameters
  isBuiltIn?: boolean;           // true for builtin presets
}
```

#### CompressionStrategyType
```typescript
type CompressionStrategyType = "none" | "summarize" | "aggressive" | "token-budget";
```

#### CompressionParams
```typescript
interface CompressionParams {
  keepRecent?: number;          // Messages to keep intact (summarize)
  maxTokens?: number;          // Token limit (token-budget, summarize)
  toolCompressionLevel?: "none" | "light" | "aggressive";  // Tool output compression
}
```

#### CompressionConfig
```typescript
interface CompressionConfig {
  defaultPreset: string;        // ID of default preset
  enabled: boolean;             // Global enable/disable
  compressAfterMessages: number;  // Trigger threshold
}
```

## Builtin Presets

The system includes 3 optimized presets:

```typescript
const BUILTIN_PRESETS: CompressionPreset[] = [
  {
    id: "builtin-aggressive",
    name: "Aggressive",
    description: "Maximum compression - keeps only 5 recent messages",
    strategy: "aggressive",
    params: { keepRecent: 5 },
    isBuiltIn: true
  },
  {
    id: "builtin-standard",
    name: "Standard",
    description: "Balanced compression - keeps 10 recent messages",
    strategy: "summarize",
    params: { keepRecent: 10, maxTokens: 4000 },
    isBuiltIn: true
  },
  {
    id: "builtin-minimal",
    name: "Minimal",
    description: "Minimal compression - keeps 20 recent messages",
    strategy: "summarize",
    params: { keepRecent: 20, maxTokens: 6000 },
    isBuiltIn: true
  }
];
```

## Integration Points

### VS Code Configuration Panel

**Location**: `src/ui/configPanel.ts`

The config panel receives messages from the webview and delegates to CompressionManager:

```typescript
case "add-compression-preset": {
  const { CompressionManager } = await import("../compression");
  const cm = CompressionManager.getInstance();
  // Multi-step input: name, description, strategy, params
  const preset = await collectPresetDetails();
  cm.createPreset(preset);
  await this.pushState();
}

case "edit-compression-preset": {
  const { CompressionManager } = await import("../compression");
  const cm = CompressionManager.getInstance();
  cm.updatePreset(message.id, updates);
  await this.pushState();
}

case "remove-compression-preset": {
  const { CompressionManager } = await import("../compression");
  const cm = CompressionManager.getInstance();
  cm.deletePreset(message.id);
  await this.pushState();
}

case "set-compression-preset-default": {
  const { CompressionManager } = await import("../compression");
  await CompressionManager.getInstance().setDefaultPreset(message.value);
  await this.pushState();
}
```

### Webview UI Generation

**Location**: `src/ui/configHtml.ts`

The `compressionView()` function generates the HTML for the compression tab:

```typescript
function compressionView() {
  const { CompressionManager } = require("../compression");
  const cm = CompressionManager.getInstance();
  const presets = cm.listPresets();
  const defaultId = cm.getConfig().defaultPreset;
  
  const presetCards = presets.map(preset => `
    <div class="preset-card ${preset.id === defaultId ? 'default' : ''}">
      <!-- Preset content with Edit/Delete/Set Default buttons -->
    </div>
  `).join('');
  
  return `
    <div class="compression-view">
      <div class="presets-grid">${presetCards}</div>
      <button id="create-preset">Create New Preset</button>
    </div>
  `;
}
```

### Session Integration

The compression system integrates with chat sessions through:

1. **Auto-compact**: Automatically applies compression when history grows
2. **Manual compact**: User can trigger compression on demand
3. **Preset selection**: Users can change preset per-session

## Storage and Persistence

Presets are stored in VS Code's global state:

```typescript
private storageKey = "symposium.compression.presets";
private configKey = "symposium.compression.config";

// Save presets
private async savePresets() {
  const presetsArray = Array.from(this.presets.values());
  await this.context.globalState.update(this.storageKey, presetsArray);
}

// Load presets
private async loadPresets() {
  const stored = this.context.globalState.get<CompressionPreset[]>(this.storageKey);
  if (stored) {
    stored.forEach(p => this.presets.set(p.id, p));
  }
}
```

## Event Listeners in Webview

The compression UI uses event delegation for performance:

```typescript
// In configPanel.ts webview message handler
case "compression-action": {
  const { action, presetId } = message;
  switch (action) {
    case "edit":
      await this.handleEditCompressionPreset(presetId);
      break;
    case "delete":
      await this.handleDeleteCompressionPreset(presetId);
      break;
    case "set-default":
      await this.handleSetCompressionPresetDefault(presetId);
      break;
  }
}
```

## Extending the System

### Adding New Compression Strategies

1. Define the strategy type in `CompressionStrategyType`
2. Add parameters to `CompressionParams`
3. Implement the compression logic in the chat session manager
4. Update the UI to show strategy options

### Custom Preset Validation

Add validation in `CompressionManager`:

```typescript
validatePreset(preset: CompressionPreset): { valid: boolean; error?: string } {
  if (!preset.name.trim()) {
    return { valid: false, error: "Name is required" };
  }
  if (preset.strategy === "summarize" && (preset.params.keepRecent || 0) < 1) {
    return { valid: false, error: "keepRecent must be at least 1" };
  }
  return { valid: true };
}
```

### Adding Preset Categories

Extend `CompressionPreset` to include categories:

```typescript
interface CompressionPreset {
  // ... existing fields
  category?: "development" | "review" | "debugging" | "general";
}
```

Update UI to group presets by category.

## Performance Considerations

- **Lazy loading**: CompressionManager is loaded on-demand
- **Event delegation**: Single listener for all preset actions
- **Virtual scrolling**: Consider for large preset lists
- **Debounced saves**: Prevent excessive state updates

## Testing Strategy

Key test scenarios:
1. Create/delete/edit custom presets
2. Set/unset default preset
3. Verify builtin presets are protected
4. Test preset persistence across VS Code restarts
5. Validate UI renders correctly for all preset types

## Security Considerations

- User input validation for preset names
- Sanitization of preset descriptions (XSS prevention)
- Prevent preset ID collision
- Validate parameter ranges

## Future Enhancements

- Preset import/export functionality
- Preset templates for common workflows
- AI-suggested presets based on usage patterns
- Compression analytics and optimization suggestions
- Preset sharing between teams

## Related Files

- `src/compression.ts` - Core compression logic
- `src/ui/configPanel.ts` - Configuration panel backend
- `src/ui/configHtml.ts` - Webview HTML generation
- `docs/compression-guide.md` - User guide
- `src/extension.ts` - Extension initialization

## Changelog

### 2026-06-27
- Added complete UI for compression preset management
- Implemented create/edit/delete/set-default functionality
- Added event listeners for compression actions
- Created user documentation
- Integrated with existing CompressionManager