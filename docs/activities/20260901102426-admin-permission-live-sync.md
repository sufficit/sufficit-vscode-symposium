# Sincronização do modo Admin com a sessão ativa

Status: **FINALIZED** (2026-09-01)

## Problema

No adaptador Sufficit AI/OpenAI-compatible, uma conversa podia continuar pedindo
aprovação mesmo com o seletor exibindo **admin**. A interface publicava sempre o
modo padrão do adaptador ao reabrir a conversa, enquanto a sessão ativa podia
estar aplicando um modo anterior. Além disso, a normalização do esforço criava
uma cópia das opções da sessão; mudanças posteriores de permissão alcançavam o
controller, mas não necessariamente essa cópia usada pelo executor de tools.

## Correção

- O metadado da conversa agora separa o modo efetivo do modo padrão.
- O seletor mostra a política realmente aplicada pelo controller ativo.
- A mudança no seletor é enviada imediatamente ao host, sem esperar a próxima
  mensagem.
- Toda mensagem também sincroniza sua permissão com a sessão já existente,
  cobrindo clientes antigos e mensagens enfileiradas.
- Ao mudar para uma política que dispensa uma aprovação já aberta, a sessão
  libera a chamada pendente como aprovada; em **admin**, nenhum prompt antigo
  permanece bloqueando o turno.

## Versionamento

- `symposium.adapter.openai-compatible`: `1.0.1`
- `symposium.chat-ui`: `1.0.1`
- release: `v2026.901.1`

## Verificação

Os testes cobrem a sincronização com opções normalizadas, a liberação de uma
aprovação já pendente, a atualização imediata pelo seletor e a distinção entre
modo efetivo e modo padrão na reabertura da conversa.
