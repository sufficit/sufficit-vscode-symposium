# Como Gerenciar Presets de Compressão

O Symposium permite configurar presets de compressão para otimizar o uso de tokens em sessões longas. A compressão resume mensagens antigas mantendo apenas as mais recentes completas, economizando tokens sem perder contexto importante.

## Acessando a UI de Compression

1. Abra o painel de configurações do Symposium
2. Clique no tab **"Compression"**
3. Você verá todos os presets disponíveis com suas configurações

## Presets Builtin

O Symposium inclui 3 presets otimizados:

### 🚀 Aggressive
- **Estratégia**: agressive
- **Mantém**: 5 mensagens recentes
- **Ideal para**: Sessões extremamente longas onde você quer economia máxima de tokens

### ⚙️ Standard
- **Estratégia**: summarize
- **Mantém**: 10 mensagens recentes
- **Ideal para**: Sessões moderadas - equilíbrio entre economia e contexto

### 🎯 Minimal
- **Estratégia**: summarize
- **Mantém**: 20 mensagens recentes
- **Ideal para**: Sessões curtas onde contexto é mais importante que economia

## Criando um Preset Customizado

1. Clique no botão **"Create New Preset"**
2. Digite um **Nome** para o preset (ex: "Review Code", "Debug", "Sprints")
3. (Opcional) Adicione uma **Descrição** explicando quando usar
4. Escolha a **Estratégia** de compressão:
   - **none**: Sem compressão - mantém todo histórico
   - **summarize**: Resume mensagens antigas, mantém N recentes
   - **aggressive**: Compressão máxima - só 5 mensagens recentes
   - **token-budget**: Limite de tokens - corta pelo tamanho estimado
5. Configure os parâmetros específicos da estratégia
6. O preset será salvo automaticamente

## Editando Presets Customizados

1. Encontre o preset que deseja editar
2. Clique no botão **"Edit"**
3. Modifique as configurações desejadas
4. Salve as alterações

> **Nota**: Presets builtin (Aggressive, Standard, Minimal) não podem ser editados ou deletados.

## Deletando Presets Customizados

1. Encontre o preset customizado que deseja remover
2. Clique no botão **"Delete"**
3. Confirme a exclusão

## Definindo o Preset Padrão

1. Encontre o preset que deseja usar como padrão
2. Clique no botão **"Set Default"**
3. O preset ficará marcado com o badge **"Default"**
4. Este preset será usado automaticamente em novas sessões

## Estratégias de Compressão

### Summarize
Resume mensagens antigas mantendo as N mais recentes completas. Parâmetros:
- `keepRecent`: Quantas mensagens manter inteiras (padrão: 10)
- `maxTokens`: Limite de tokens para resumos (padrão: 4000)

### Aggressive
Compressão máxima - mantém apenas 5 mensagens recentes completas. Ideal para sessões muito longas.

### None
Sem compressão - mantém todo o histórico de mensagens. Use quando contexto completo é mais importante que economia de tokens.

### Token Budget
Limita o total de tokens usados. Corta mensagens antigas até atingir o limite. Parâmetros:
- `maxTokens`: Limite máximo de tokens total

## Dicas de Uso

- **Desenvolvimento**: Use `Minimal` (20 mensagens) para manter contexto do código
- **Review de Código**: Crie preset customizado com `summarize` e 15 mensagens
- **Debugging**: Use `Aggressive` (5 mensagens) para focar no problema atual
- **Sessões Longas**: Considere `token-budget` para controlar custos

## Integração com VS Code

Os presets de compressão são salvos automaticamente nas configurações do VS Code. Você pode:
- Usar preset padrão em todas as sessões
- Alterar preset durante uma sessão
- Sincronizar configurações entre máquinas (se habilitado)

## Problemas Comuns

**Q: Por que meus presets customizados sumiram?**
A: Verifique se você está no mesmo workspace do VS Code. Presets são salvos por workspace.

**Q: Como saber qual preset está ativo?**
A: O preset com badge "Default" na UI é o padrão. Você também pode ver o preset atual no painel de chat.

**Q: Posso usar compressão durante uma sessão?**
A: Sim! A compressão é aplicada automaticamente quando o histórico cresce. Você pode trocar preset a qualquer momento.

## Mais Informações

- Veja o manual completo de compressão: `Comando: Symposium: Show Compression Manual`
- Documentação de Compaction: Tab "Compaction" no painel de configurações
- Configurações avançadas: VS Code Settings → Extensions → Symposium