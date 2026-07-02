# API de Configurações do Symposium

## Visão Geral

A API do Symposium agora inclui suporte completo para manipular configurações via código, eliminando a necessidade de editar manualmente o arquivo `settings.json`.

## API de Settings

A seção `settings` da API fornece quatro métodos principais:

### `getAll()`

Retorna todas as configurações do Symphony como um mapa plano de `key → value`.

```typescript
const api = getSymposiumApi();
const settings = await api.settings.getAll();

console.log(settings);
// {
//   "symposium.voice.stt.engine": "whisper",
//   "symposium.voice.tts.voice": "en-US-JennyNeural",
//   "symposium.backends.openai.apiKey": "***",
//   ...
// }
```

### `get(key: string)`

Retorna uma configuração específica pelo seu caminho completo.

```typescript
const api = getSymposiumApi();

// Obter motor de STT
const sttEngine = await api.settings.get('symposium.voice.stt.engine');

// Obter modelo configurado
const model = await api.settings.get('symposium.backends.claude.model');
```

### `set(key: string, value: unknown, target?: 'global' | 'workspace')`

Define ou atualiza uma configuração.

**Parâmetros:**
- `key`: Caminho completo da configuração (ex: `"symposium.voice.tts.voice"`)
- `value`: Valor a definir
- `target`: Escopo da configuração
  - `"global"` (padrão): Configurações de nível de usuário
  - `"workspace"`: Configurações específicas do workspace

```typescript
const api = getSymposiumApi();

// Configurar motor de STT para Whisper
await api.settings.set(
    'symposium.voice.stt.engine',
    'whisper',
    'global'
);

// Configurar voz específica
await api.settings.set(
    'symposium.voice.tts.voice',
    'pt-BR-FranciscaNeural',
    'global'
);

// Configurar API key (global)
await api.settings.set(
    'symposium.backends.openai.apiKey',
    'sk-...',
    'global'
);

// Configurar modelo apenas para este workspace
await api.settings.set(
    'symposium.backends.claude.model',
    'claude-sonnet-4',
    'workspace'
);
```

### `delete(key: string, target?: 'global' | 'workspace')`

Remove uma configuração, resetando-a para o valor padrão.

```typescript
const api = getSymposiumApi();

// Remover configuração de voz
await api.settings.delete('symposium.voice.tts.voice', 'global');

// Resetar API key para padrão
await api.settings.delete('symposium.backends.openai.apiKey', 'global');
```

## Exemplos Práticos

### Configurar Voz Completa

```typescript
const api = getSymposiumApi();

async function setupVoice() {
    // Configurar STT (Speech-to-Text)
    await api.settings.set('symposium.voice.stt.engine', 'whisper', 'global');
    await api.settings.set('symposium.voice.stt.language', 'pt-BR', 'global');

    // Configurar TTS (Text-to-Speech)
    await api.settings.set('symposium.voice.tts.engine', 'azure', 'global');
    await api.settings.set('symposium.voice.tts.voice', 'pt-BR-FranciscaNeural', 'global');
    await api.settings.set('symposium.voice.tts.speed', 1.0, 'global');
    await api.settings.set('symposium.voice.tts.enabled', true, 'global');

    // Configurar microfone
    await api.settings.set('symposium.voice.microphone.device', 'default', 'global');

    console.log('✅ Voz configurada com sucesso!');
}

setupVoice();
```

### Configurar Backend

```typescript
const api = getSymposiumApi();

async function setupClaudeBackend(apiKey) {
    // Definir API key
    await api.settings.set(
        'symposium.backends.claude.apiKey',
        apiKey,
        'global'
    );

    // Definir modelo padrão
    await api.settings.set(
        'symposium.backends.claude.model',
        'claude-sonnet-4',
        'global'
    );

    // Habilitar backend
    await api.settings.set(
        'symposium.backends.claude.enabled',
        true,
        'global'
    );
}
```

### Migrar Configurações Existentes

```typescript
const api = getSymposiumApi();

async function migrateFromOldFormat(oldConfig) {
    // Migrar configurações antigas para o novo formato via API
    if (oldConfig.voiceEngine) {
        await api.settings.set(
            'symposium.voice.stt.engine',
            oldConfig.voiceEngine,
            'global'
        );
    }

    if (oldConfig.voiceName) {
        await api.settings.set(
            'symposium.voice.tts.voice',
            oldConfig.voiceName,
            'global'
        );
    }

    console.log('✅ Migração concluída');
}
```

### Ler e Mostrar Configurações Atuais

```typescript
const api = getSymposiumApi();

async function displayCurrentSettings() {
    const settings = await api.settings.getAll();

    console.log('=== Configurações do Symphony ===\n');

    // Voz
    console.log('🎤 Voz:');
    console.log(`  STT Engine: ${settings['symposium.voice.stt.engine'] || 'n/a'}`);
    console.log(`  TTS Voice: ${settings['symposium.voice.tts.voice'] || 'n/a'}`);
    console.log(`  TTS Enabled: ${settings['symposium.voice.tts.enabled'] || 'false'}`);

    // Backends
    console.log('\n🤖 Backends:');
    console.log(`  Claude Model: ${settings['symposium.backends.claude.model'] || 'n/a'}`);
    console.log(`  OpenAI Model: ${settings['symposium.backends.openai.model'] || 'n/a'}`);

    // Hub
    console.log('\n🔗 Hub:');
    console.log(`  URL: ${settings['symposium.hub.url'] || 'não configurado'}`);
    console.log(`  Configured: ${settings['symposium.hub.url'] ? 'sim' : 'não'}`);
}
```

## Estrutura de Chaves

As chaves das configurações seguem o padrão `symposium.<categoria>.<subcategoria>.<propriedade>`:

### Voz
- `symposium.voice.stt.engine` - Motor de STT (whisper, vosk, etc.)
- `symposium.voice.stt.language` - Idioma do STT
- `symposium.voice.tts.engine` - Motor de TTS (azure, amazon, etc.)
- `symposium.voice.tts.voice` - Nome da voz
- `symposium.voice.tts.speed` - Velocidade da fala (número)
- `symposium.voice.tts.enabled` - Se TTS está habilitado
- `symposium.voice.microphone.device` - Dispositivo de microfone

### Backends
- `symposium.backends.claude.apiKey` - API key do Claude
- `symposium.backends.claude.model` - Modelo padrão do Claude
- `symposium.backends.openai.apiKey` - API key da OpenAI
- `symposium.backends.openai.model` - Modelo padrão da OpenAI

### Hub
- `symposium.hub.url` - URL do Hub
- `symposium.hub.token` - Token do Hub

### Session
- `symposium.session.contextLines` - Linhas de contexto
- `symposium.session.maxTokens` - Tokens máximos
- `symposium.session.temperature` - Temperatura

## Integração com VS Code Extension

Para usar a API dentro de uma VS Code extension:

```typescript
import * as vscode from 'vscode';
import { createSymposiumApi } from './api/symposiumApi';
import { LiveSessions } from './sessions/runtime';
import { AgentAdapter } from './adapters/types';

export function activate(context: vscode.ExtensionContext) {
    // ... setup code ...

    // Criar API
    const api = createSymposiumApi({
        live: liveSessions,
        adapters: adapters,
        onSessionsChanged: onSessionsChangedEvent,
    });

    // Expor API via comandos
    const setVoiceCommand = vscode.commands.registerCommand(
        'symposium.setVoice',
        async (engine: string, voice: string) => {
            await api.settings.set('symposium.voice.stt.engine', engine, 'global');
            await api.settings.set('symposium.voice.tts.voice', voice, 'global');
            vscode.window.showInformationMessage(`Voz configurada: ${engine} / ${voice}`);
        }
    );

    context.subscriptions.push(setVoiceCommand);
}
```

## Benefícios da API de Settings

1. **Type Safety**: Métodos tipados para evitar erros
2. **Atomicidade**: Atualizações são aplicadas corretamente
3. **Scoping**: Suporte claro para global vs workspace
4. **Validação**: Validação automática de chaves e valores
5. **Eventos**: VS Code emite eventos quando configurações mudam
6. **Testabilidade**: Fácil de mock e testar
7. **Documentação**: Métodos auto-documentados via TypeScript

## Migrando de Edição Manual

Se você tem código que edita `settings.json` manualmente, substitua por:

### Antes (não recomendado):
```typescript
const fs = require('fs');
const path = require('path');

const settingsPath = path.join(vscode.workspace.rootPath, '.vscode', 'settings.json');
const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
settings['symposium.voice.tts.voice'] = 'pt-BR-FranciscaNeural';
fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
```

### Depois (recomendado):
```typescript
await api.settings.set('symposium.voice.tts.voice', 'pt-BR-FranciscaNeural', 'workspace');
```

## Veja Também

- `examples/settings-api-usage.js` - Exemplos focados em configuração
- `examples/symposium-api-usage.js` - Exemplos completos da API
- Documentação da API principal em `src/api/symposiumApi.ts`