# Retry condicionado ao reset de limite da sessão

Status: **FINALIZED** (2026-09-01)

## Incidente

O adaptador Claude apresentava um erro de limite rígido, por exemplo
`You've hit your session limit · resets 2:30pm (America/Sao_Paulo)`, mas tratava
a resposta como não recuperável. A interface mostrava apenas **Edit** e dizia que
Retry não estava disponível, mesmo quando o próprio provedor informava quando a
conta voltaria a ter limite.

## Política adotada

- Falhas transitórias curtas, como HTTP 429 e indisponibilidade de transporte,
  continuam usando auto-retry limitado.
- Limites rígidos de sessão/conta não são reenviados automaticamente horas
  depois. O envio tardio inesperado poderia executar uma intenção que o usuário
  já não deseja mais.
- O erro permanece visível com contagem regressiva e horário local do reset.
- O botão **Retry** permanece oculto até o prazo informado pelo provedor e é
  revelado automaticamente quando o limite volta a estar disponível.
- **Edit** continua disponível durante a espera.
- O host valida novamente o prazo para impedir um Retry prematuro enviado por
  uma webview antiga ou adulterada.

## Implementação

- O prazo `retryAt` foi adicionado ao erro normalizado e ao histórico.
- O Claude transforma o horário com timezone informado pelo CLI em timestamp e
  o preserva em sessões reabertas.
- A projeção AHP mantém `retryAt` nos metadados do erro, tanto ao vivo quanto no
  histórico.
- `automaticRetry: false` diferencia limite rígido de falha transitória sem
  perder a recuperabilidade manual.
- A webview usa estado acessível (`role=status`, `aria-live`) e numerais
  tabulares para o countdown.

## Versionamento de features

- `symposium.adapter.claude`: `1.1.0`
- `symposium.recovery`: `1.2.0`
- `symposium.chat-ui`: `1.1.0`
- `symposium.ahp`: `0.6.1` (mantém compatibilidade com `0.6.0`)

## Release

- alvo: `v2026.901.7`

## Verificação

- typecheck do host: aprovado
- typecheck da webview: aprovado
- 47 testes direcionados finais: aprovados
- suíte integral: 714 testes aprovados, 0 falhas
- detector de UI: nenhum achado novo no bloco alterado; avisos reportados são
  preexistentes em outras regras do CSS
- limites estruturais: todos os arquivos com no máximo 400 linhas
- arquitetura: 462 módulos, 0 ciclos conhecidos, 0 módulos inalcançáveis
- VSIX: 41 arquivos, 509.006 bytes; allowlist aprovada
