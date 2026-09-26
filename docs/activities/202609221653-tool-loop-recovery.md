# Atividade — recuperação automática de loops de ferramenta

Data: 2026-09-22 16:53 -03  
Seção reproduzida: `16e44773-fa9a-43da-814f-b9ba0efdb3ef`

## Objetivo

Impedir que o adaptador Sufficit AI encerre abruptamente um turno quando o
modelo solicita repetidamente a mesma ferramenta, preservando um limite seguro
contra loops infinitos.

## Estado inicial e causa

A extensão com o limite de três chamadas já estava carregada desde 16:25. O
ledger mostrou que o turno 14 executou duas leituras de
`EfiReconciliationPage.razor`; a terceira solicitação idêntica foi corretamente
bloqueada, mas o guardrail terminou o turno imediatamente com aviso terminal.
Assim, o comportamento percebido como “parando do nada” era uma decisão do
próprio guardrail, não congelamento nem ausência de resposta do backend.

O fingerprint `01dd33ee12f5db67` também reapareceu depois de `continue`, provando
que o modelo insistia na mesma leitura apesar de o resultado já estar no
contexto.

Em paralelo, `symposium.ahp.diagnostics` estava habilitado e cada alteração de
sessão escrevia um dump com até 40 divergências antigas. Isso produzia blocos
grandes e repetidos no log do Extension Host.

## Mudanças

### Recuperação do turno

- `RepeatedToolCallGuard` agora decide entre `execute`, `recover` e `stop`.
- A terceira solicitação consecutiva idêntica é pulada sem executar novamente a
  ferramenta.
- O resultado anterior permanece no contexto e uma orientação durável pede ao
  modelo que o reutilize, faça outra ação ou responda ao usuário.
- O runner oferece duas recuperações internas no mesmo turno. Apenas a terceira
  insistência após essas orientações produz parada terminal.
- Um tool call diferente comprova progresso e reinicia o contador.
- A interface exibe um aviso não terminal de recuperação, deixando explícito
  que a duplicata foi ignorada e o turno continua.

### Diagnóstico AHP

- O dump mantém as contagens agregadas, mas inclui somente as oito divergências
  mais recentes.
- Dumps idênticos são suprimidos e mudanças são limitadas a uma emissão por 30
  segundos; uma alteração explícita da configuração ainda força uma amostra.

## Validação

- As regressões foram confirmadas vermelhas antes da implementação pelos novos
  contratos ainda inexistentes.
- 24 testes focados passaram.
- O teste de integração do `TurnRunner` executa duas leituras, pula a terceira
  duplicata e recebe uma resposta final na quarta requisição, no mesmo turno.
- Há cobertura para duas recuperações, parada determinística na terceira
  insistência, carry-over entre turnos, reset após progresso, aviso não terminal,
  amostra diagnóstica e throttling.
- `npm run verify` passou integralmente: formatação, ESLint, typecheck,
  testes/cobertura, tamanho, complexidade, engenharia, arquitetura e bundle.
- `npm run package:vsix` passou.
- `npm run check:vsix` passou: 41 arquivos e 526.761 bytes.
- `git diff --check` passou.

## Entrega e operação

O histórico da seção não foi alterado. O VSIX pode substituir a mesma versão
local, mas o código em memória somente muda depois de um reload normal do VS
Code. Nenhum Extension Host foi interrompido durante a implementação.
