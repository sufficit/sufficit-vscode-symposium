# Atividade — renovação automática do uso do Claude

**Data:** 2026-08-19 12:47 (America/Sao_Paulo)  
**Escopo:** painel de uso do adaptador Claude no VS Code e no Code Server

## Sintoma

Após um período ocioso, especialmente durante a noite, o painel mostrava
`No data yet` e informava HTTP 401 no endpoint de uso do Claude. Uma mensagem
enviada pelo CLI fazia o uso aparecer novamente, porque o CLI atualizava as
credenciais OAuth no disco.

## Diagnóstico

O Symposium já renovava o token quando o `expiresAt` local indicava expiração,
mas não tratava a revogação ou rotação antecipada de um token ainda marcado
como válido localmente. Assim, o endpoint de estatísticas recebia um token
rejeitado, enquanto o CLI podia corrigir o estado na próxima requisição.

## Implementação

- `claudeOAuthToken(true)` permite uma renovação forçada usando o
  `refreshToken`, sem depender do `expiresAt` local.
- A consulta de uso repete no máximo uma vez após HTTP 401, somente depois de
  obter um token renovado ou atualizado por outra janela do Code Server.
- O request HTTP do uso foi isolado em `usageRequest.ts`, preservando o limite
  de 400 linhas por arquivo.
- A leitura periódica já existente continua atualizando o adaptador a cada
  minuto; agora ela também consegue se recuperar sem exigir o envio de uma
  mensagem artificial.

## Testes e validações

- Novo teste reproduz: token localmente válido → HTTP 401 → refresh OAuth →
  consulta bem-sucedida, incluindo a persistência do token renovado.
- `npm run verify` aprovado: lint, typecheck, testes unitários, cobertura,
  guardrails de tamanho/engenharia/arquitetura e compilação do bundle.

## Release

- Versão: `2026.819.1`
- Tag: `v2026.819.1` (a publicar após o commit na `develop`)
- Instalação local e no Code Server será verificada após a publicação.
