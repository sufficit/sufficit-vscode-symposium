# Atividade — integração com o pipeline governado de memória

**Data:** 2026-08-24
**Escopo:** adaptador OpenAI/Sufficit AI, ferramentas de memória, compactação e catálogo MCP
**Status:** concluída

## Contrato adotado

- turnos principais enviam `session_id` no corpo e `X-Symposium-Session-Id`
  como fronteira de sessão confiável;
- `memory_search` aceita estratégia exata, semântica ou híbrida, orçamento de
  tokens e diversidade MMR, preservando scores e justificativas retornadas;
- memória canônica é exclusivamente remota: falhas de busca, leitura ou
  gravação são explícitas e não criam uma segunda verdade em armazenamento
  local;
- o fallback local permanece apenas para guardrails de sessão, como mecanismo
  de compatibilidade operacional, e não para conhecimento canônico;
- compactações carregam a sessão para diagnóstico, mas enviam
  `X-Sufficit-Memory-Learning: off`, evitando aprender resumos sintéticos;
- o catálogo MCP nativo apresenta timeline, relações, atualização e revisão de
  candidatos além das operações básicas de memória.

## Segurança e escopo

O cabeçalho de sessão é gerado pelo host do Symposium. Um argumento criado pelo
modelo pode filtrar resultados, mas não autoriza a leitura de memória interna de
outra conversa. Sem Hub configurado, ferramentas canônicas de memória nem são
anunciadas ao modelo.

## Regressões

- ausência das ferramentas canônicas quando o Hub está indisponível;
- erro remoto explícito sem leitura ou gravação local alternativa;
- defaults de busca híbrida e propagação da sessão confiável;
- `session_id` e cabeçalho de sessão no turno principal;
- opt-out de aprendizado durante compactação;
- catálogo MCP com revisão de candidatos.

## Validação

- `npm run verify` aprovado;
- lint, typecheck da extensão e do webview aprovados;
- suíte unitária/cobertura e verificações de arquitetura aprovadas;
- bundles da extensão e da PWA gerados com sucesso;
- todos os arquivos de produção permanecem dentro do limite rígido de 400 linhas.
