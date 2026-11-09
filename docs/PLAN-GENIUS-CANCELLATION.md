# Cancelamento do Genius no Symposium

Objetivo: propagar origem de cancelamento, explicar a interrupção e oferecer continuação explícita na mesma sessão sem replay; atualizações não interrompem turnos ativos.

1. [concluído] Fixar contrato JSONL, pontos de admissão e retomada existentes; criar regressões reproduzíveis.
2. [concluído] Genius: motivo estruturado (service_stopping/user_cancelled/timeout), checkpoint de encerramento e lease de manutenção atômico que recusa atualização ocupada e bloqueia novos turnos durante instalação.
3. [concluído] Symposium: preservar motivo, apresentar texto específico e permitir continuação explícita; cancelamento do usuário não retenta e nenhum erro reenvia pedido original automaticamente.
4. [concluído] Executar testes de integração isolados e verificações completas dos dois repositórios, sem reiniciar serviços reais.
5. [em andamento] Registrar resultados, commit/push na main, conferir CI remoto e limpar somente worktrees desta tarefa quando seguro.

Restrições: preservar alterações paralelas, não reiniciar Genius/VS Code, não publicar release nem substituir código de processos ativos. Reaproveitar checkpoint/retomada existentes; sem recuperação automática nova. Genius #1452, Symposium #90. CI Genius: bash scripts/ci-local.sh. Symposium: npm run verify, mais regressões direcionadas.
