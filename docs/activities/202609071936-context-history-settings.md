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
- `npx tsc -p .` e `npm run test:unit`: 658 testes aprovados, zero falhas.
- `COVERAGE_BASE_SHA=4db304d6711ddda68b04baace7857074f7180dc1 npm run verify`:
  lint, formatação, typechecks, testes/cobertura, guardrails e build aprovados.
  Cobertura das linhas alteradas conferida após o commit: 97,28% (143/147; mínimo 85%).
- `npm run check:size`: fontes com até 400 linhas.
- `npm run check:configscript`: scripts válidos em EN/PT-BR.
- `git diff --check`: sem problemas de whitespace.
- Webview real renderizada com ponte do VS Code simulada: gravação numérica
  confirmada; seis campos numéricos; sem erro JavaScript ou overflow em 1200/390 px.
  Revisão visual encerrou com disposição ship após os ajustes.

O teste antigo que esperava remover a última mensagem do usuário foi atualizado
para o novo contrato, mantendo a verificação dos pares de ferramenta. Testes novos
cobrem valores inválidos, configuração dinâmica, preservação, resumo e paginação.

A primeira CI remota apontou quatro violações de lint nos mocks do compactador;
foram corrigidas com import estático e promises explícitas. A checagem com a base
da PR também revelou cobertura insuficiente; testes do aviso de omissão, leitura
configurável e preferências de adaptadores personalizados fecharam essa lacuna.
Entrega: [PR #53](https://github.com/sufficit/sufficit-vscode-symposium/pull/53).

Verify, Extension Host e CodeQL passaram no GitHub. A validação do VSIX identificou
379 bytes acima do orçamento de 800 KiB; descrições repetitivas da seção foram
encurtadas em EN/PT-BR, com nova aprovação da revisão de texto. A suíte de 658
testes e o build passaram novamente. `npm ci` no clone isolado resolveu a árvore
de dependências compartilhada que impedia o empacotador local. `npm run package:vsix`
e `npm run check:vsix` passaram: 41 arquivos, pacote de 495.788 bytes e bundle
de 818.945 bytes, dentro do teto de 819.200. O limite de tamanho não foi aumentado.

Não houve instalação da extensão. A consulta depende do conteúdo efetivamente
persistido; não recupera truncamentos antigos. Orçamento total por tokens, busca
semântica e novo journal de persistência não fazem parte desta entrega.
