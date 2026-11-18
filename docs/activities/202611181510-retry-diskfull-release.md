# Release das correções de Retry e disco cheio

Pedido explícito do mantenedor: gerar release após merge na main.

Symposium 2026.1118.1: Retry com turno ocupado não reenfileira mais a mesma mensagem; erros de disco cheio/quota (ENOSPC, EDQUOT, -122, -28) em /tmp passam a ter mensagem acionável. package.json, lock e VERSION.md atualizados; main publicada e develop avançada por fast-forward antes da tag anotada, conforme o guardrail.
