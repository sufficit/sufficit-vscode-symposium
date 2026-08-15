# Projeção em tempo real dos turnos Claude

Status: **Concluído**
Data: **2026-08-15**
Release: **v2026.815.4**

## Problema

No adapter Claude, uma mensagem podia ser enviada e processada normalmente,
mas o chat não acompanhava texto, ferramentas nem o estado do turno em tempo
real. O conteúdo só aparecia depois que o usuário clicava novamente na sessão,
forçando a reconstrução do histórico.

## Diagnóstico

- o processo Claude continuava executando e gravando seu transcript nativo;
- o render ledger do Symposium recebia os deltas no mesmo instante;
- o stream do Claude não continha o evento normalizado `turn-start`;
- sem um turno ativo, a projeção AHP rejeita corretamente deltas de texto,
  ferramentas, erros e encerramento sem correlação;
- reabrir a sessão mascarava o defeito porque o histórico era reconstruído do
  transcript nativo, fora do caminho incremental.

Portanto, a falha não era atraso de arquivo, polling, versão do Claude nem
websocket do code-server: era uma lacuna no contrato de ciclo de vida do
adapter Claude.

## Implementação

- cada envio Claude agora emite `turn-start` antes de qualquer aviso síncrono,
  erro de coordenação, delta ou evento do provedor;
- o limite recebe um `logicalTurnId` exclusivo por turno;
- o `intentId` criado pelo controller é preservado para correlação entre envio,
  fila, ledger e projeção;
- erros anteriores ao spawn também passam a formar um turno completo, em vez
  de produzir eventos órfãos.

## Testes e validação

- o contrato do adapter verifica que `turn-start` é o primeiro evento Claude e
  antecede o primeiro texto;
- o teste de falha de spawn verifica dois turnos consecutivos, seus IDs e
  respectivos `intentId`, evitando regressão no caminho de erro;
- testes focados Claude/contrato: **11 aprovados**;
- suíte completa, cobertura e guardrails de webview, configuração, tamanho,
  complexidade, engenharia e arquitetura: **aprovados**.

