# Auditoria e consolidação da documentação do Symposium

O [índice](../README.md) é o único arquivo na raiz de `docs/`. Guias, referências de integração e material de manutenção usam nomes em kebab-case. As análises e diagnósticos pontuais foram movidos para o arquivo histórico, com indicação de escopo e referências a revisões do código quando necessário. Os registros de atividade e as avaliações de PR mantêm a convenção de data.

A documentação ativa passou de 2.957 para 1.366 linhas, excluindo planos, atividades, avaliações e arquivo histórico. Os guias de compressão e os exemplos de teste duplicados foram consolidados nos manuais de usuário e na referência de implementação. A auditoria corrigiu a leitura paginada do Genius, o contexto do Codex, o comportamento da API de configurações, segurança da Bridge, mecanismos de compressão e persistência do AHP.

Os quatro manuais integrados em português e inglês passaram a fazer parte do VSIX. A lista de arquivos exige esses manuais e continua a rejeitar outros documentos no pacote.

## Validação

- `npm run check:markdown` e os testes automatizados do verificador passaram.
- A checagem complementar percorreu 189 arquivos Markdown, incluindo o plano temporário, e validou 132 referências locais e cinco fragmentos antes do encerramento. Os links de código dos relatórios antigos foram conferidos no Git.
- `npm run verify` passou com 1.082 testes. O VSIX de validação local passou na checagem com 45 arquivos e 562.148 bytes.
- A entrega foi feita na main. A publicação do pacote segue o fluxo próprio de release.
