# Avaliações de pull requests

Esta pasta guarda a análise durável de pull requests avaliados para o
Symposium. O objetivo é preservar decisões, riscos, valor aproveitado, partes
descartadas e o resultado real depois da avaliação — inclusive quando um PR
grande é dividido em vários menores.

## Nomenclatura

Use:

```text
YYYYMMDD-pr-<número>-<resumo-em-kebab-case>.md
```

Exemplo:

```text
20260730-pr-41-startup-performance-evaluation.md
```

A data é a do início da avaliação. Mantenha o mesmo arquivo quando o resultado
for atualizado; não crie uma segunda documentação apenas para registrar o
encerramento.

## Conteúdo mínimo

Cada avaliação deve registrar:

1. data, número/link do PR, autor, branch e estado da avaliação;
2. problema que o PR tenta resolver e escopo observado;
3. achados por recorte, com valor, risco e dependências;
4. decisão para cada recorte: integrar, ajustar, adiar ou descartar;
5. validações necessárias e lacunas conhecidas;
6. resultado final, com PRs/commits/releases que materializaram a decisão;
7. itens rejeitados ou ainda pendentes e o motivo.

## Estados

- `em avaliação`: análise ainda aberta;
- `parcial`: parte integrada e parte ainda aguardando decisão ou execução;
- `concluída`: decisões executadas ou explicitamente encerradas;
- `descartada`: nenhuma parte será integrada, com justificativa registrada.

Uma avaliação concluída permanece nesta pasta. Trabalho futuro identificado por
ela deve virar um `docs/PLAN-*.md`; depois de implementado, o resultado passa
para `docs/activities/` seguindo a convenção de data e resumo já usada ali.
