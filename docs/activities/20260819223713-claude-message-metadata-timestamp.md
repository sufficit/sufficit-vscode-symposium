# Atividade — Metadata temporal e modelo efetivo nas mensagens Claude

> Data: 2026-08-19 22:37 (BRT)
> Status: concluída

## Sintoma

Ao passar o mouse sobre uma resposta do adaptador Claude, o cabeçalho podia
mostrar uma hora que parecia ser a hora atual, sem representar o instante da
resposta. Em sessões restauradas, o modelo e o esforço usados também podiam
desaparecer, porque o replay do `render.jsonl` reconstruía o texto sem o
timestamp e o parser do streaming usava apenas o modelo configurado.

## Correção

- o parser Claude agora captura o timestamp do evento do provedor e o modelo
  efetivo observado no payload `message`/`stream_event`; o esforço continua
  vindo da configuração normalizada da sessão, que é o valor realmente
  enviado ao CLI;
- o timestamp passa pelo evento normalizado, pelo streaming da webview e pelo
  cabeçalho da mensagem, com `Date.now()` usado somente como fallback quando o
  provedor não fornece uma hora;
- `replayRows` e `historyFromRenderLog` preservam o timestamp das respostas,
  inclusive em histórico restaurado;
- o início de cada turno abre uma nova janela temporal, evitando reutilizar a
  hora do turno anterior;

## Testes e validação

- teste unitário do parser Claude para timestamp, modelo e esforço efetivos;
- teste de isolamento temporal entre turnos;
- teste de restauração do timestamp pelo `render.jsonl`;
- suíte completa `npm run verify` aprovada;
- detector visual executado; os avisos retornados são padrões preexistentes do
  `chat.css`, fora do cabeçalho/tooltip alterado.
