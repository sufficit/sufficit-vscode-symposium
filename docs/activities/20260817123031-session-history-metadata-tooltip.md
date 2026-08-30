# Metadados do histórico e tooltip resiliente

Status: **Concluído**  
Data: **2026-08-17**

## Problemas

- tooltips com texto longo podiam ultrapassar a janela ou ficar cortados;
- o histórico de sessões exibia adaptador e horário, mas não informava o
  modelo nem o esforço de raciocínio utilizados;
- metadados observados durante uma sessão não eram preservados para a próxima
  abertura da lista.

## Implementação

- o tooltip agora respeita o viewport, quebra palavras longas e permite
  rolagem quando o conteúdo excede a altura disponível;
- a lista de sessões exibe adaptador, modelo e esforço em sequência compacta,
  com tooltip acessível contendo os valores completos;
- Claude, Codex, Copilot e OpenAI passam a extrair e transportar os metadados
  disponíveis;
- o estado observado ao vivo é salvo no armazenamento da extensão para que o
  histórico continue informativo entre recarregamentos e janelas;
- valores ausentes são exibidos explicitamente como `unavailable`, sem
  inventar informação.

## Testes e guardrails

- regressões para tooltip, viewport, modelo/esforço e persistência do
  histórico;
- cobertura de parsing de metadados Claude e Codex;
- suíte completa, typechecks host/webview, bundle, tamanho, engenharia e
  arquitetura aprovados;
- detector visual executado nos componentes alterados; os avisos retornados
  são padrões preexistentes do stylesheet e não atingem o tooltip ou o
  histórico alterados.
