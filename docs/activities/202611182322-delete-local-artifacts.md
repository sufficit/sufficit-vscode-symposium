# Exclusão de subagentes sem falso erro de limpeza

## Causa e mudança

A descoberta de sessões Claude usa `<parent>/subagents/<agent>`. A limpeza comum rejeitava qualquer barra, depois que o adapter já havia apagado o transcript. Isso produzia `Delete failed: Invalid session id for local artifact cleanup` e interrompia a remoção do índice/store mesmo após a exclusão no provedor.

A validação aceita IDs simples e o formato explícito de subagente. Continua rejeitando caminhos arbitrários, segmentos vazios, ponto, traversal, barras invertidas, NUL e dois-pontos. Ancestrais symlink são bloqueados antes de registrar tombstone ou apagar arquivos. Não há supressão genérica de erros de exclusão.

## Evidências

- Teste com ID de subagente falhou antes da correção e passou depois.
- `npm run verify:package`: aprovado com 1.070 testes, formatação, lint, tipos, cobertura, verificações estruturais, build e allowlist do VSIX.
- Após acrescentar caso de cascata, `compile:test` e seis testes de localArtifacts passaram; lint do arquivo de testes também aprovado.
- Diretórios temporários provaram preservação de pai/irmãos, repetição da limpeza, cascata pai antes do filho, rejeição de traversal e de symlink intermediário.
- Nenhuma sessão real foi excluída para testar; comportamento interativo após reload ainda não observado.

## Entrega

Versão 2026.1118.2 instalada e listada no VS Code local e code-server development. Janelas existentes precisam de reload; nenhum processo foi interrompido. Código entregue na main conforme preferência do mantenedor. Sem nova tag/publicação nas lojas neste escopo.

Checkpoints concluídos: diagnóstico, regressão, correção, validação e instalação. Plano convertido nesta atividade; pendências anteriores de autenticação Genius permanecem em seu próprio plano.
