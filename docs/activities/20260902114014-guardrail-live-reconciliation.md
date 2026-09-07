# Guardrail criado pelo agente aparece imediatamente

Status: **FINALIZED** (2026-09-02)

## Incidente

Após `add_guardrail` concluir com sucesso, o host lia o registro novo pelo ID e
o publicava na faixa de painéis acima do composer. Ao mesmo tempo, disparava
consultas de reconciliação pelo índice assíncrono do Hub. Enquanto esse índice
ainda não continha o registro, uma resposta vazia substituía a lista otimista e
o guardrail desaparecia até uma recarga posterior.

## Correção

- Guardrails obtidos por ID ficam protegidos por uma janela de reconciliação de
  60 segundos, equivalente à política já utilizada para tarefas recém-criadas.
- Resultados temporariamente vazios do índice são mesclados com esses registros
  otimistas, sem preservar linhas antigas que não foram criadas nessa operação.
- Quando o índice alcança a gravação, a lista canônica não duplica o item.
- Remover ou limpar guardrails descarta imediatamente o estado otimista e
  atualiza o painel antes da reconciliação remota.
- O estado otimista é apagado ao trocar de sessão, impedindo vazamento entre
  conversas.

## Versionamento

- extensão: `2026.902.1`
- `symposium.sync`: `1.0.1`
- `symposium.chat-ui`: `1.1.1`

## Verificação

- 16 testes direcionados de guardrails aprovados;
- teste integrado reproduz a sequência leitura por ID seguida de busca vazia;
- typechecks do host e da webview aprovados;
- detector de UI sem achados nos arquivos alterados;
- suíte integral: 717 testes aprovados, 0 falhas;
- limite estrutural de 400 linhas preservado;
- arquitetura: 462 módulos, 0 ciclos e 0 módulos inalcançáveis;
- VSIX: 41 arquivos, 509.188 bytes, allowlist aprovada.

## Release

- alvo: `v2026.902.1`
