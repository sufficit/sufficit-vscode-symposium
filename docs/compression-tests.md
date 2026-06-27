# Compression Manager - Testes

## Estrutura de Testes

Os testes do CompressionManager devem cobrir:

1. **Gerenciamento de Presets**
   - Criar presets customizados
   - Editar presets existentes
   - Deletar presets customizados
   - Proteção de presets builtin
   - Listar presets corretamente

2. **Configuração Padrão**
   - Definir preset padrão
   - Obter preset padrão
   - Validar preset padrão existe

3. **Persistência**
   - Salvar presets no VS Code global state
   - Carregar presets do VS Code global state
   - Sincronizar com workspace

4. **Validação**
   - Validar nomes de presets
   - Validar parâmetros por estratégia
   - Verificar IDs únicos

## Exemplos de Testes

### Teste Básico de Criação de Preset

```typescript
import { suite, test } from "node:test";
import assert from "node:assert";
import { CompressionManager } from "../src/compression";

suite("CompressionManager - Preset Creation", () => {
  test("deve criar preset customizado com sucesso", async () => {
    const cm = CompressionManager.getInstance();
    
    const newPreset = {
      id: "custom-test",
      name: "Test Preset",
      description: "Test description",
      strategy: "summarize" as const,
      params: { keepRecent: 15, maxTokens: 3000 }
    };
    
    cm.createPreset(newPreset);
    
    const retrieved = cm.getPreset("custom-test");
    assert(retrieved);
    assert.strictEqual(retrieved.name, "Test Preset");
    assert.strictEqual(retrieved.strategy, "summarize");
    assert.strictEqual(retrieved.params.keepRecent, 15);
  });
  
  test("deve rejeitar preset sem nome", async () => {
    const cm = CompressionManager.getInstance();
    
    const invalidPreset = {
      id: "invalid",
      name: "",
      strategy: "summarize" as const,
      params: { keepRecent: 10 }
    };
    
    assert.throws(() => cm.createPreset(invalidPreset), /Nome é obrigatório/);
  });
});
```

### Teste de Proteção de Presets Builtin

```typescript
suite("CompressionManager - Builtin Presets Protection", () => {
  test("não deve permitir deletar presets builtin", async () => {
    const cm = CompressionManager.getInstance();
    
    const builtinId = "builtin-aggressive";
    
    assert.throws(() => cm.deletePreset(builtinId), /Preset builtin não pode ser deletado/);
  });
  
  test("não deve permitir editar presets builtin", async () => {
    const cm = CompressionManager.getInstance();
    
    const builtinId = "builtin-standard";
    
    assert.throws(
      () => cm.updatePreset(builtinId, { name: "Modified" }),
      /Preset builtin não pode ser editado/
    );
  });
});
```

### Teste de Configuração Padrão

```typescript
suite("CompressionManager - Default Preset", () => {
  test("deve definir e obter preset padrão", async () => {
    const cm = CompressionManager.getInstance();
    
    await cm.setDefaultPreset("builtin-aggressive");
    const defaultPreset = cm.getDefaultPreset();
    
    assert.strictEqual(defaultPreset.id, "builtin-aggressive");
    assert.strictEqual(defaultPreset.name, "Aggressive");
  });
  
  test("deve manter preset padrão válido", async () => {
    const cm = CompressionManager.getInstance();
    
    // Tentar definir preset inexistente
    await cm.setDefaultPreset("non-existent");
    const defaultPreset = cm.getDefaultPreset();
    
    // Deve manter um preset válido (provavelmente builtin-standard)
    assert(defaultPreset);
    assert.strictEqual(typeof defaultPreset.id, "string");
  });
});
```

### Teste de Persistência

```typescript
suite("CompressionManager - Persistence", () => {
  test("deve salvar e carregar presets", async () => {
    const cm = CompressionManager.getInstance();
    
    const testPreset = {
      id: "persist-test",
      name: "Persistence Test",
      strategy: "aggressive" as const,
      params: { keepRecent: 3 }
    };
    
    cm.createPreset(testPreset);
    await cm.savePresets();
    
    // Simular recarregamento
    const newManager = CompressionManager.getInstance();
    await newManager.loadPresets();
    
    const loaded = newManager.getPreset("persist-test");
    assert(loaded);
    assert.strictEqual(loaded.name, "Persistence Test");
  });
});
```

### Teste de Validação de Parâmetros

```typescript
suite("CompressionManager - Parameter Validation", () => {
  test("deve validar keepRecent mínimo", async () => {
    const cm = CompressionManager.getInstance();
    
    const invalidPreset = {
      id: "invalid-params",
      name: "Invalid Params",
      strategy: "summarize" as const,
      params: { keepRecent: 0 }  // Deve ser pelo menos 1
    };
    
    assert.throws(
      () => cm.createPreset(invalidPreset),
      /keepRecent deve ser pelo menos 1/
    );
  });
  
  test("deve validar maxTokens positivo", async () => {
    const cm = CompressionManager.getInstance();
    
    const invalidPreset = {
      id: "invalid-tokens",
      name: "Invalid Tokens",
      strategy: "token-budget" as const,
      params: { maxTokens: -100 }  // Deve ser positivo
    };
    
    assert.throws(
      () => cm.createPreset(invalidPreset),
      /maxTokens deve ser positivo/
    );
  });
});
```

## Testes de Integração

### Teste de UI de Compression

```typescript
suite("Compression UI Integration", () => {
  test("webview deve renderizar presets corretamente", async () => {
    const { CompressionManager } = await import("../src/compression");
    const cm = CompressionManager.getInstance();
    
    const presets = cm.listPresets();
    const html = compressionView();  // Importado de configHtml
    
    assert(html.includes("Aggressive"));
    assert(html.includes("Standard"));
    assert(html.includes("Minimal"));
    
    // Verificar se preset padrão tem classe 'default'
    const defaultId = cm.getConfig().defaultPreset;
    assert(html.includes(`preset-card ${defaultId}`));
  });
});
```

### Teste de Handlers de Mensagens

```typescript
suite("Compression Message Handlers", () => {
  test("handler add-compression-preset deve funcionar", async () => {
    const panel = createMockConfigPanel();
    const message = {
      type: "add-compression-preset",
      preset: {
        id: "test-custom",
        name: "Custom Test",
        strategy: "summarize",
        params: { keepRecent: 12 }
      }
    };
    
    await panel.handleMessage(message);
    
    const cm = CompressionManager.getInstance();
    const created = cm.getPreset("test-custom");
    assert(created);
    assert.strictEqual(created.name, "Custom Test");
  });
  
  test("handler remove-compression-preset deve deletar custom preset", async () => {
    const panel = createMockConfigPanel();
    const message = {
      type: "remove-compression-preset",
      id: "test-custom"
    };
    
    await panel.handleMessage(message);
    
    const cm = CompressionManager.getInstance();
    const deleted = cm.getPreset("test-custom");
    assert(!deleted);
  });
});
```

## Setup de Testes

### Mock do VS Code Context

```typescript
import type { ExtensionContext } from "vscode";

function createMockContext(): ExtensionContext {
  const globalState = new Map<string, any>();
  
  return {
    globalState: {
      get: (key: string) => globalState.get(key),
      update: (key: string, value: any) => {
        globalState.set(key, value);
        return Promise.resolve();
      }
    },
    workspaceState: {
      get: (key: string) => null,
      update: (key: string, value: any) => Promise.resolve()
    }
  } as unknown as ExtensionContext;
}
```

### Mock do ConfigPanel

```typescript
function createMockConfigPanel() {
  return {
    pushState: async () => {
      // Mock do método pushState
    },
    handleMessage: async (message: any) => {
      // Importa e executa o handler real
      const { ConfigPanel } = await import("../src/ui/configPanel");
      const panel = new ConfigPanel(createMockContext());
      return panel.handleMessage(message);
    }
  };
}
```

## Executando os Testes

```bash
# Instalar dependências de teste
npm install --save-dev @types/node

# Rodar todos os testes
npm test

# Rodar apenas testes do compression manager
npm test -- --grep "CompressionManager"

# Rodar com cobertura
npm run test:coverage
```

## Cobertura Esperada

- **Gerenciamento de Presets**: 95%+
- **Validação**: 90%+
- **Persistência**: 85%+
- **Integração UI**: 80%+

## Próximos Passos

1. Implementar testes baseados nos exemplos acima
2. Adicionar testes de edge cases
3. Implementar mocks para VS Code API
4. Configurar CI para rodar testes automaticamente
5. Adicionar relatórios de cobertura

## Recursos Adicionais

- [Node.js Test Runner](https://nodejs.org/api/test.html)
- [VS Code Extension Testing](https://code.visualstudio.com/api/working-with-extensions/testing-extension)
- [TypeScript Testing](https://www.typescriptlang.org/docs/handbook/declaration-files/do-s-and-don-ts.html)