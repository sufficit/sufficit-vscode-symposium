# Padronização dos nomes das atividades

Padronizamos 96 nomes em `YYYYMMDDHHmm-descrição.md`. Em 82 arquivos com segundos, mantivemos o minuto já registrado. Em 14 arquivos que traziam apenas a data, usamos o horário do commit da entrega indicada no registro ou o primeiro commit que adicionou o documento. Preservamos as datas originais. Em dois registros de junho, o horário do commit em UTC coincide com a data do arquivo.

O verificador de Markdown agora valida o nome das atividades mesmo quando elas estão fora da navegação obrigatória. As referências a arquivos renomeados foram atualizadas em Markdown e nos comentários de teste.

## Origem dos horários completados

- `202606211318-session-hooks-bootstrap-complete.md` — `4c7d532`, São Paulo.
- `202606230258-chatsurface-surfacedialogues.md` — `06f11b6`, UTC.
- `202606231119-chatsurface-surfacemessages-complete.md` — `cec9482`, São Paulo.
- `202606230230-chatsurface-surfacesync.md` — `9e2476f`, UTC.
- `202606231119-openai-session-decomposed-complete.md` — `cec9482`, São Paulo.
- `202606232251-read-session-live-runtime-complete.md` — `8192f30`, São Paulo.
- `202606232332-render-log-persistence-partial.md` — `1493a35`, São Paulo.
- `202607271239-ahp-phase-0-foundation-complete.md` — `9143f5e`, São Paulo.
- `202608110144-ahp-legacy-transport-retired.md` — `dc87746`, São Paulo.
- `202608110144-message-lifecycle-hardening.md` — `dc87746`, São Paulo.
- `202608241900-memory-learning-pipeline-integration.md` — `3ebafdf`, São Paulo.
- `202608290016-gemini-antigravity-filter-and-session-discovery.md` — `35b545a`, São Paulo.
- `202609071804-live-retry-integration.md` — `d454c3b`, São Paulo.
- `202609101651-device-popup-auth-release.md` — `d10c102`, São Paulo.

## Validação

A comparação dos 96 arquivos com o Git confirmou que o conteúdo mudou somente onde havia referências renomeadas. A verificação de links locais encontrou 131 referências válidas, incluindo as atividades. Os nove testes do verificador Markdown e os 1.083 testes de `npm run verify` passaram. Entrega na main.
