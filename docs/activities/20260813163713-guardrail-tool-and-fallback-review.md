# Activity — guardrail como ferramenta de conversa e fallback local

**Status:** Concluída
**Data:** 2026-08-13

## Diagnóstico

O guardrail canônico do Symposium é `add_guardrail`. Ele é uma mudança
persistente de política da sessão, não uma mensagem de usuário comum: a regra é
salva com `type=guardrail`, escopo de `sessionId` e privacidade `internal`, e é
reinjetada no prompt de cada despacho. O nome “Rio” foi preservado como uma
ambiguidade de transcrição de voz; nenhuma ferramenta nova com esse nome foi
criada.

Foram encontrados quatro desalinhamentos:

1. O catálogo dizia que a ferramenta era universal, mas o construtor de turnos
   removia todas as ferramentas de memória quando o Hub não estava configurado.
2. A recarga de guardrails antes do despacho estava limitada a adaptadores
   `roleAware`, embora o contrato diga “every message”.
3. Guardrails gravados no `LocalMemory` durante uma falha do Hub não eram
   reidratados pelo controlador nem pelo painel ao reabrir a sessão.
4. O texto do prompt dizia que o conteúdo armazenado tinha prioridade absoluta,
   o que podia fazê-lo competir indevidamente com política de sistema,
   segurança ou uma correção explícita do usuário.

O `appsettings.json` anexado pertence ao `sufficit-identity` e não contém uma
configuração de guardrails do Symposium. Como observações separadas para o
ambiente de identidade local: o CORS não lista a origem do code-server, há
senhas vazias para certificados/RabbitMQ e os grants legados `Password` e
`None` estão habilitados. Isso deve permanecer explicitamente restrito ao
ambiente local; não foi alterado nesta atividade.

## Implementação

- Guardrail e memória básica permanecem expostos quando o Hub está indisponível,
  usando `LocalMemory`; as ferramentas exclusivas do Hub continuam gated.
- O controlador recarrega guardrails para qualquer adaptador que tenha sessão,
  não apenas para adaptadores role-aware.
- O controlador e o painel usam o fallback local em queda do Hub e preservam o
  último cache válido quando uma resposta local vazia não prova que a lista
  compartilhada foi apagada.
- Expiração local passa a ser respeitada; guardrails vazios ou expirados não
  voltam para o prompt. O texto tem limite de 1000 caracteres e a sessão tem
  limite de 50 regras exibidas.
- A criação e remoção de guardrails são classificadas como mudanças destrutivas
  de política para exigir aprovação no modo `manager`.
- O prompt agora explicita que a regra deve ter sido solicitada/aprovada pelo
  usuário e nunca supera política de sistema/desenvolvedor nem a correção mais
  recente do usuário.
- A remoção/limpeza pelo painel também alcança o armazenamento local quando o
  Hub está indisponível.

## Testes executados

- `npm run typecheck`
- `npm run typecheck:webview`
- `npm run lint`
- `node --require ./test/register-vscode-stub.cjs --test out/test/guardrails.test.js` (12 casos)

Os testes específicos passaram, cobrindo filtro de sessão, expiração, limites,
disponibilidade sem Hub, classificação de permissão e recarga após falha.

## Lacuna deliberada / próximo plano

O catálogo nativo de ferramentas é executado pelo bridge OpenAI-compatible. Nos
CLIs Claude/Codex/Copilot, a regra continua sendo injetada pelo host em cada
mensagem, mas a chamada autônoma de `add_guardrail` só existe se o respectivo
MCP do backend estiver configurado. A próxima evolução deve criar um contrato
MCP único para os três CLIs, com a mesma aprovação e o mesmo escopo de sessão,
antes de afirmar paridade completa de ferramentas entre adaptadores.
