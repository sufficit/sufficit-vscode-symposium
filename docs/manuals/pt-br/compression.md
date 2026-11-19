# Compactação de contexto

Em sessões Sufficit AI e compatíveis com OpenAI, o Symposium pode limitar
o histórico enviado ao modelo ou substituir o contexto antigo por um
resumo. A transcrição original continua disponível. Os backends de CLI
gerenciam seu próprio contexto.

1. Abra **Symposium: Configuration** e selecione **Contexto e histórico**.
2. Ajuste **Máximo de mensagens no histórico** para limitar a janela da
   requisição. O valor `0` remove esse limite local de mensagens. O
   provedor continua aplicando o limite de contexto.
3. Para resumir turnos automaticamente, ajuste **Compactação automática**
   entre 60% e 90% da janela do modelo. O padrão é desativado. Use
   `/compact` em um chat compatível com OpenAI para solicitar o resumo
   manualmente.

O resumo mantém uma parte recente do histórico. O padrão é de seis
mensagens e pode abranger mais para preservar chamadas de ferramentas
com seus resultados. Se precisar de um detalhe, peça ao agente para
buscar o trecho relevante com `read_session`.

O painel também lista presets de compressão de requisição. Um preset é
aplicado quando a sessão o fornece ao adaptador compatível com OpenAI.
O preset **Limite de Tokens** usa uma estimativa. Para gerar um resumo
pelo backend, use `/compact`.

Veja o [diagnóstico do histórico de ferramentas](openai-history.md) ou o
[manual em inglês](../en/compression.md).
