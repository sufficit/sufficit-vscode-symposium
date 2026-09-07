# Configurações de contexto e consulta ao histórico

Data: 2026-09-07, 19:36 (America/Sao_Paulo).
Origem: sessão `06ef6f0b-6ec4-4eff-96da-26b21c3eb703`.

O pedido foi expor políticas de contexto e priorizar recuperação do original sobre
resumo obrigatório. A aba de compactação existente tinha limites fixos e a leitura
de sessão não permitia continuar por caracteres.

## Alterações e decisões

A aba **Contexto e histórico** agora expõe tamanho da leitura, aviso de omissão,
cauda do resumo, meta de tokens e prévias de argumentos/resultados, junto à janela
existente. Números são validados e alterações parciais preservam as demais opções.
Getters aplicam preferências às próximas requisições de sessões já abertas.

Compactação automática é desativada por padrão; escolhas explícitas existentes
continuam valendo. O resumo usa papel `assistant`. A seleção preserva a última
mensagem do usuário e pares de ferramentas mesmo quando excedem o teto nominal.
O aviso é temporário e a seleção não altera o ledger. `read_session` oferece cursor
por caracteres no corpo, estável quando novas mensagens acrescentam ao histórico.

Contrato, controles, defaults e limites: [CONTEXT-HISTORY.md](../CONTEXT-HISTORY.md).
Entrega na branch `feat/context-history-settings`, para revisão, sem publicação.

## Validação

- `npm run compile`: TypeScript, webview, PWA e bundle aprovados.
- `npx tsc -p .` e `npm run test:unit`: 656 testes aprovados, zero falhas.
- `npm run check:size`: fontes com até 400 linhas.
- `npm run check:configscript`: scripts válidos em EN/PT-BR.
- `git diff --check`: sem problemas de whitespace.
- Webview real renderizada com ponte do VS Code simulada: gravação numérica
  confirmada; seis campos numéricos; sem erro JavaScript ou overflow em 1200/390 px.
  Revisão visual encerrou com disposição ship após os ajustes.

O teste antigo que esperava remover a última mensagem do usuário foi atualizado
para o novo contrato, mantendo a verificação dos pares de ferramenta. Testes novos
cobrem valores inválidos, configuração dinâmica, preservação, resumo e paginação.

Não houve instalação da extensão. A consulta depende do conteúdo efetivamente
persistido; não recupera truncamentos antigos. Orçamento total por tokens, busca
semântica e novo journal de persistência não fazem parte desta entrega.
