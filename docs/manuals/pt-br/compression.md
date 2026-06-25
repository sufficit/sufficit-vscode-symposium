# Manual de Compressão

## Visão Geral

O sistema de compressão do Symposium reduz o uso de tokens comprimindo o histórico da conversa antes de enviar ao LLM. Isso permite conversas mais longas sem atingir limites de contexto.

## Aba Compressão

Acesse via **Configurações do Symposium → Compression**

### Auto-compactação

**Auto-compact threshold** - Ativa compressão automática quando contexto atinge:
- Desabilitado (0%) - Apenas compressão manual via `/compact`
- 60-90% - Comprime ao atingir esta % da janela de contexto do modelo

**Max history messages** - Limita mensagens recentes enviadas por requisição:
- Ilimitado (0) - Envia todas as mensagens
- 20-200 - Mantém apenas N mensagens mais recentes
- Prompts system/developer preservados separadamente

### Limites de Turno

**Step limit per turn** - Máximo de chamadas de ferramentas antes de pausar:
- 10-200 passos
- Ignorado em modo autônomo (presença Away)

**Stop if no reply** - Proteção anti-loop:
- Para após N passos de ferramenta sem texto do assistente
- Ilimitado (0) - Nunca para automaticamente

## Presets de Compressão

Presets definem **como** comprimir mensagens quando limites são atingidos.

### Presets Integrados

**None** - Sem compressão, histórico completo
- Uso: Sessões curtas, debugging, revisar contexto completo

**Summarize** - Mantém mensagens recentes, resume antigas
- Padrão: 10 mensagens recentes
- Uso: Balanceado - maioria das conversas

**Aggressive** - Compressão máxima
- Mantém apenas 5 mensagens recentes
- Uso: Sessões longas, orçamento baixo de tokens

**Token Budget** - Comprime para caber no limite de tokens
- Padrão: 4000 tokens
- Uso: Modelos com janelas de contexto pequenas

### Presets Personalizados

**Criar Novo Preset**:

1. **Nome** - Nome descritivo (ex: "Debug Profundo")
2. **Descrição** - Quando usar este preset
3. **Estratégia** - Algoritmo de compressão:
   - `none` - Sem compressão
   - `summarize` - Manter N recentes
   - `aggressive` - Manter 5 recentes
   - `token-budget` - Caber sob limite de tokens
4. **Parâmetros da Estratégia**:
   - `summarize`/`aggressive`: **Mensagens a manter** (1-100)
   - `token-budget`: **Tokens máximos** (500-200000)
5. **Nível de Compressão de Ferramentas**:
   - `none` - Requisições completas no histórico
   - `low` - Remove headers resolvidos pelo servidor (contextId, sessionId)
   - `medium` - Compacta em hints de ação ("salvou tarefa")
   - `high` - Remove chamadas já processadas

**Editar Preset** - Clique no botão editar para modificar todos os parâmetros

**Deletar Preset** - Remove presets personalizados (integrados protegidos)

**Definir Padrão** - Preset padrão para novas sessões

## Compressão de Requisições de Ferramentas

Separada da compressão de mensagens - reduz **argumentos de chamadas** no histórico:

### Níveis de Compressão

**Low** - Remove campos redundantes:
- `contextId`, `sessionId` (servidor já os tem)
- Headers `source`
- Economiza ~10-20 tokens por chamada

**Medium** - Compacta em hints:
```json
// Antes
{ "type": "memory_save", "title": "Tarefa X", "summary": "...", "payload": "{...}" }

// Depois (medium)
{ "_compressed": true, "action": "salvou task-anchor", "title": "Tarefa X" }
```
Economiza ~80-200 tokens por save

**High** - Remove chamadas processadas:
- Chamadas já executadas → removidas do histórico
- Apenas erros/falhas mantidos
- Economiza ~100% dos tokens de ferramentas bem-sucedidas

### Ferramentas Suportadas

Atualmente comprimidas:
- `memory_save` / `mcp__Sufficit_AI__memory_save`
- `memory_search` / `mcp__Sufficit_AI__memory_search`
- `memory_get_observations` / `mcp__Sufficit_AI__memory_get_observations`

Mais ferramentas serão adicionadas baseado em padrões de uso.

## Pipeline de Compressão em Dois Estágios

Ao enviar mensagens ao LLM:

**Estágio 1: Compressão de Requisições de Ferramentas**
- Comprime inputs individuais de chamadas de ferramentas
- Aplicado baseado no `toolCompressionLevel` do preset

**Estágio 2: Compressão em Nível de Mensagem**
- Aplica estratégia do preset (summarize/aggressive/token-budget)
- Remove/resume mensagens antigas

## Sobrescritas por Sessão

Altere compressão no meio da conversa:

1. Clique no seletor de compressão na UI do chat
2. Escolha preset para esta sessão
3. Aplica imediatamente na próxima mensagem
4. Salvo no estado da sessão (sobrevive reaberturas)

## Armazenamento de Configurações

- **Presets**: `symposium.compression.presets` (global)
- **Padrão**: `symposium.compression.defaultPreset`
- **Por sessão**: `symposium.compression.sectionConfigs`

## Melhores Práticas

**Sessões curtas (< 20 mensagens)**: Use `none`
- Contexto completo ajuda no debugging
- Custo baixo de tokens mesmo assim

**Desenvolvimento normal**: Use `summarize` (padrão)
- Mantém 10 mensagens recentes
- Resume histórico eficientemente

**Sessões longas de debugging**: Crie preset personalizado
- Estratégia: `summarize`
- Manter: 20 mensagens
- Nível tool: `medium`

**Modelos com limite de tokens**: Use `token-budget`
- Defina limite para 70% da janela do modelo
- Deixa espaço para ferramentas + resposta

**Fluxos com muita memória**: Ative compressão de ferramentas
- Nível: `medium` ou `high`
- Economiza 60-80% tokens em operações de memória

## Solução de Problemas

**Erros "Context too long"**:
1. Reduza threshold de auto-compact (70% → 60%)
2. Reduza max history messages (40 → 20)
3. Use preset mais agressivo
4. Ative compressão de ferramentas (medium/high)

**Contexto importante perdido**:
1. Aumente mensagens a manter no preset
2. Use `/compact` manualmente (preserva no ledger)
3. Use ferramenta `read_session` para recuperar histórico completo

**Compressão não funcionando**:
1. Verifique se preset não é `none`
2. Verifique threshold de auto-compact > 0
3. Verifique se sessão não sobrescreveu para `none`
4. Procure diagnósticos de compressão nos eventos de uso
