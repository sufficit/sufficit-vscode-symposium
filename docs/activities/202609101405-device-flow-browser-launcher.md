# Device Flow do Symposium com launcher do Identity

Abertura direta por openExternal deixava a conclusão sem opener e sem fechamento automático. A versão 2026.910.1 usa `/device/launch` na origem do Identity para manter a aba inicial enquanto um popup controlado executa o login. Apenas user_code/launch_mode são enviados; parâmetros de retorno e fragmentos são descartados. Outros caminhos de provedores permanecem inalterados. Copiar URL e fallback também utilizam o launcher.

O token continua vindo exclusivamente do polling OAuth do host. O servidor deve ser publicado antes desta versão. Popup bloqueado, JavaScript desabilitado ou aba externa com histórico que recuse fechamento mantêm orientação manual; não existe promessa de contornar restrições do navegador.

Validação: `npm run verify:package` aprovado, 765 testes, lint, formatação, typechecks, arquitetura e VSIX. Bundle 837,6 KiB dentro do teto existente. Testes verificam URL, remoção de dados não necessários, código inválido, providers distintos e apresentação no desktop/web/cópia/falha de abertura. No Identity: 1.179 testes e quatro testes Chrome, incluindo fechamento real da aba inicial e popup, recusa e mensagens inválidas. Referência em docs/DEVICE-FLOW-BROWSER.md.

Integração, release e instalação continuam rastreadas no plano ativo PLAN-device-popup-release.md e serão registradas em relatório de publicação ao finalizar. PLAN-live-retry.md pertence a outra atividade e foi preservado.
