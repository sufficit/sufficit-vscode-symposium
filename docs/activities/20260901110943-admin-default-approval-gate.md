# Default Admin aplicado ao gate de aprovação OpenAI

Status: **FINALIZED** (2026-09-01)

## Problema

O rodapé da conversa mostrava **openai · admin**, mas ferramentas destrutivas
ainda abriam o card de autorização. A interface usava `admin` como fallback
visual do adaptador, enquanto sessões sem override mantinham
`options.permission` indefinido. Com contenção de escrita ativa, o executor
interpretava esse valor indefinido como diferente de `admin` e exigia aprovação.

## Correção

- A sessão OpenAI-compatible materializa o modo padrão configurado antes de
  criar o runtime e o executor de ferramentas.
- Sem configuração explícita, o modo efetivo passa a ser `admin` também no
  estado interno, não somente na interface.
- O estado de aprovação ganhou uma proteção adicional: uma sessão efetivamente
  em `admin` aprova imediatamente e nunca emite card nem pausa a ferramenta.
- Overrides explícitos de `manager`, `user` e `plan` continuam preservados.

## Versionamento

- `symposium.adapter.openai-compatible`: `1.0.2`
- release: `v2026.901.3`

## Verificação

Os testes confirmam que uma permissão omitida recebe o default `admin` e que
uma solicitação destrutiva nesse modo é resolvida sem evento de aprovação.
