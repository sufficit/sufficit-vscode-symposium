# Retry automático após atualização do provedor

Pedido: HTTP 503 `Sufficit AI — update in progress` deve entrar na recuperação automática após ferramentas concluídas.

## Alteração

O adaptador classifica HTTP 408, 429 e 5xx como retentáveis independentemente de ferramentas anteriores. O controller existente continua aplicando o limite, backoff, cancelamento e preferência de recuperação após ferramentas. A retomada reutiliza o histórico do pedido original (texto ou imagem), incluindo resultados salvos, sem reinserir mensagem/preamble nem reiniciar objetivo e progresso. Pedido editado continua sendo uma nova instrução. Erros permanentes de autenticação continuam sem retry automático.

## Validação

- Antes da correção: três regressões falharam (classificação HTTP 503 e duplicação de histórico com texto/imagem).
- `npm run verify`: passou; 891 testes, build, cobertura, lint, formato, typechecks e guards. O verificador de complexidade emite avisos legados e retorna sucesso.
- Após acrescentar integração entre erro HTTP 503 e controller: 29 testes focados passaram; lint e format:check passaram novamente.
- Teste da retomada após ferramenta: corpo da requisição preservado, uma mensagem de usuário, uma execução de ferramenta e resposta final.

## Entrega

Issue: https://github.com/sufficit/sufficit-vscode-symposium/issues/78
PR: https://github.com/sufficit/sufficit-vscode-symposium/pull/79
Genius: cobertura equivalente na PR https://github.com/sufficit/sufficit-ai-genius/pull/1117; runtime já retenta o passo pendente.
Sem publicação/instalação de extensão nesta entrega.
