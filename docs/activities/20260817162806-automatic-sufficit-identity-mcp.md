# MCP automático do Sufficit Identity

Status: **Concluído**  
Data: **2026-08-17**

## Objetivo

Disponibilizar simultaneamente os MCPs do Sufficit AI e do Sufficit Identity
em todos os adaptadores CLI, usando a autenticação já mantida pelo Symposium e
sem exigir configuração manual ou um segundo login.

## Contrato entregue

- `sufficit_ai` continua apontando para `https://ai.sufficit.com.br/mcp` e só é
  habilitado para uma sessão nativa durável, preservando os headers de origem,
  permissão e isolamento da conversa;
- `sufficit_identity` aponta para `<symposium.identity.url>/api/mcp`, reutiliza
  o access token do login do Sufficit Identity e fica disponível imediatamente
  após a autenticação;
- Claude, Codex e Copilot recebem os dois servidores automaticamente;
- aliases configurados manualmente são removidos antes da injeção para que não
  existam servidores duplicados ou credenciais divergentes;
- alteração do token ou da URL do Identity renova a configuração e reinicia o
  processo persistente do Claude na próxima requisição;
- a tela de configuração reconhece os dois servidores nativos e lista as
  ferramentas de memória, agentes, Vault e self-service separadamente.

## Segurança

- nenhum token é incluído na linha de comando;
- Codex referencia a variável protegida `SYMPOSIUM_SUFFICIT_MCP_TOKEN`;
- os arquivos temporários de Claude e Copilot continuam com modo `0600`;
- o MCP do Identity usa o `sub` do access token como fronteira do Vault pessoal;
- o MCP do AI mantém a exigência adicional de ID durável da conversa.

## Validação

- testes de coexistência, aliases, idempotência do TOML, token, URL e espera por
  sessão durável;
- smoke público confirmou `401` com o discovery RFC 9728 em
  `https://identity.sufficit.com.br/api/mcp`;
- typechecks host/webview e guardrail de tamanho aprovados antes da suíte
  completa de release.
