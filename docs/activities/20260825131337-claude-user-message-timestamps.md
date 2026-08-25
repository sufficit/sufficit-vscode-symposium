# Atividade — Horário correto nas mensagens de usuário do Claude

> Data: 2026-08-25 13:13 (BRT)
> Status: concluída

## Sintoma

Mensagens do usuário restauradas pelo adaptador Claude exibiam a época Unix
(`31/12/1969`) ou a hora atual ao passar o mouse. O timestamp correto existia
no transcript nativo do Claude e nos eventos da resposta, mas não era
persistido no registro de renderização do usuário nem propagado pela projeção
AHP.

## Causa confirmada

- eventos `type: "user"` eram persistidos sem `ts`;
- o horário de submissão não acompanhava a mensagem enquanto ela aguardava na
  fila ou era injetada como `steer`;
- o histórico transformava um timestamp ausente em `new Date(0)`;
- a webview substituía timestamps ausentes por `Date.now()` em alguns caminhos,
  fazendo histórico antigo parecer recém-enviado.

## Correção

- o roteador captura o instante de submissão antes de qualquer fila e o mantém
  até o envio ou a injeção no turno ativo;
- eventos de usuário persistem `ts`, e a projeção AHP usa esse valor em
  `chat/turnStarted`;
- o replay preserva timestamps explícitos e, para ledgers antigos, herda o
  primeiro timestamp real da resposta do mesmo turno;
- a UI oculta horários ausentes, inválidos ou sentinela, sem fabricar a hora
  atual e sem renderizar 1969/1970;
- o mesmo contrato é aplicado ao histórico legado e ao snapshot AHP.

## Testes e validação

- regressões para envio direto, fila e `steer` com timestamp estável;
- regressões para replay explícito e compatibilidade com ledger legado;
- regressões da projeção AHP para o horário do usuário e para o fallback do
  primeiro evento real;
- teste DOM garantindo que `new Date(0)` não produz rótulo visual;
- sessão real `eaaebcfd-e423-4f96-8b4c-d319b9730f59` validada: a mensagem
  `veja os logs` deixou de ser época Unix e foi restaurada no minuto correto;
- `npm test` aprovado, incluindo cobertura e guardrails de tamanho,
  complexidade, engenharia e arquitetura;
- detector visual Impeccable executado sem achados.
- orçamento do bundle host ajustado de 788 para 790 KiB: a release anterior
  já deixava apenas 57 bytes livres, e o novo bundle validado permanece com
  cerca de 1,2 KiB de margem sob o teto.

## Release

- versão: `2026.825.1`;
- branch: `develop`;
- artefato esperado: `sufficit-vscode-symposium-2026.825.1.vsix`.
