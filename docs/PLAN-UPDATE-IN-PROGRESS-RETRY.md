# Retry automático durante atualização do provedor

Objetivo: retentar HTTP 503/update in progress no mesmo passo da conversa, preservando resultados de ferramentas e sem repetir operações concluídas.

1. [EM ANDAMENTO] Identificar contrato de retry, registrar issue e preparar árvore isolada.
2. [PENDENTE] Reproduzir com teste, corrigir o retry e validar preservação dos resultados/cancelamento/limite.
3. [PENDENTE] Executar verificações do projeto, registrar atividade e entregar alterações revisáveis.

Evidência: provedor retorna 503 após ferramenta; próxima tentativa recebe o mesmo histórico, ferramenta executa uma única vez e turno termina com resposta. Limite de retry e cancelamento continuam funcionando.
Validação: Symposium compile:test, testes de regressão e npm run verify; Genius testes SessionTransientRetryTests e bash scripts/ci-local.sh.
Bloqueios: nenhum identificado.
