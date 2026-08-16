# Claude usage: diagnóstico de autenticação sem falso logout

**Data:** 2026-08-16 08:20 BRT  
**Escopo:** adaptador Claude, painel Usage limits e OAuth do Claude Code

## Diagnóstico

O painel transformava a ausência temporária de um access token OAuth em uma
afirmação de logout e instruía `claude auth login`. Isso não representa o estado
real do adaptador: o Claude CLI pode continuar funcionando por OAuth renovado,
por uma chave de API ou por uma credencial que outro processo acabou de
atualizar.

No code-server de desenvolvimento, a credencial OAuth existia e a consulta
direta a `https://api.anthropic.com/api/oauth/usage` respondeu HTTP 200 com as
janelas de uso. A mensagem exibida era, portanto, informação falsa para esse
cenário.

## Implementação

- Mensagens de ausência/rejeição OAuth agora descrevem somente a indisponibilidade
  da visualização de usage, sem afirmar logout ou exigir novo login.
- O refresh do Claude agora normaliza `expires_at` em segundos ou milissegundos.
- Refreshes concorrentes no mesmo extension host são compartilhados para evitar
  rotação simultânea do mesmo refresh token.
- Se a renovação falhar transitoriamente, o access token atual (ou um token mais
  novo persistido por outra janela) continua disponível para a tentativa; falha
  de refresh não é tratada como logout.

## Verificação

- Teste de regressão garante que mensagens de usage indisponível não contenham
  instrução de login nem atribuam logout ao Claude CLI.
- Typecheck, lint, formatação e suíte unitária executados antes do release.
- Consulta direta no ambiente de desenvolvimento confirmou HTTP 200 e janelas
  `five_hour`/`seven_day`.

