# Presets de Compressão - Guia Rápido

## O que são Presets de Compressão?

Presets de compressão são configurações pré-definidas que determinam como o Symposium gerencia o histórico de chat para economizar tokens em sessões longas.

## Presets Disponíveis

| Preset | Estratégia | Mensagens Recentes | Melhor Para |
|--------|------------|-------------------|-------------|
| 🚀 **Aggressive** | agressive | 5 | Sessões extremamente longas |
| ⚙️ **Standard** | summarize | 10 | Uso geral (padrão) |
| 🎯 **Minimal** | summarize | 20 | Sessões curtas ou foco em contexto |

## Quando Usar Cada Preset

### 🚀 Aggressive
- Sessões com centenas de mensagens
- Quando contexto é menos importante que economia
- Debugging de problemas específicos
- Testes e experimentação

### ⚙️ Standard (Padrão)
- Desenvolvimento cotidiano
- Sessões moderadas (20-50 mensagens)
- Equilíbrio entre contexto e economia
- Revisões de código

### 🎯 Minimal
- Sessões curtas (<20 mensagens)
- Quando contexto completo é crucial
- Review de código complexo
- Discussões técnicas profundas

## Criando Presets Customizados

Você pode criar presets personalizados para seus fluxos de trabalho:

1. Vá em **Settings → Symposium → Compression**
2. Clique em **"Create New Preset"**
3. Defina nome, descrição e estratégia
4. Configure parâmetros específicos

### Exemplos de Presets Customizados

**Para Review de Código:**
```
Nome: Review Code
Estratégia: summarize
Mensagens Recentes: 15
Descrição: Otimizado para revisões de código
```

**Para Debugging:**
```
Nome: Debug Profundo
Estratégia: aggressive
Mensagens Recentes: 3
Descrição: Foca no problema atual
```

**Para Sprints:**
```
Nome: Sprint Planning
Estratégia: summarize
Mensagens Recentes: 20
Descrição: Mantém contexto do sprint
```

## Estratégias de Compressão

### None (Sem Compressão)
- Mantém todo o histórico
- Usa muitos tokens
- Use apenas quando necessário

### Summarize
- Resume mensagens antigas
- Mantém as N mais recentes completas
- Economiza tokens mantendo contexto

### Aggressive
- Mantém apenas 5 mensagens recentes
- Economia máxima
- Contexto mínimo

### Token Budget
- Limita total de tokens
- Corta mensagens antigas até atingir limite
- Controle preciso de custos

## Dicas Rápidas

✅ **Comece com Standard** e ajuste conforme necessário
✅ **Crie presets para seus fluxos de trabalho** comuns
✅ **Use Aggressive apenas** para sessões muito longas
✅ **Minimal é melhor** para discussões complexas
✅ **Defina preset padrão** no painel de configurações

## Alterando Preset Durante Sessão

1. Abra painel de chat
2. Clique no ícone de configurações
3. Selecione o preset desejado
4. A compressão será aplicada automaticamente

## Economia de Tokens

| Preset | Economia | Contexto |
|--------|----------|----------|
| None | 0% | 100% |
| Minimal | ~30% | 90% |
| Standard | ~50% | 80% |
| Aggressive | ~70% | 60% |

## Problemas Comuns

**"Meu contexto sumiu!"**
→ Use um preset com mais mensagens recentes (Minimal/Standard)

**"Estou gastando muitos tokens!"**
→ Mude para Aggressive ou crie preset com token-budget

**"Não encontrei o preset ideal!"**
→ Crie um preset customizado para seu caso de uso

## Mais Informações

- Guia Completo: `docs/compression-guide.md`
- Documentação Técnica: `docs/compression-technical.md`
- Comando: `Symposium: Show Compression Manual`