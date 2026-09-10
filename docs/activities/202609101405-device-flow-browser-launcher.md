# Device Flow do Symposium com launcher do Identity

Abertura direta por openExternal deixava a conclusão sem opener e sem fechamento automático. A versão 2026.910.1 usa `/device/launch` na origem do Identity para manter a aba inicial enquanto um popup controlado executa o login. Apenas user_code/launch_mode são enviados; parâmetros de retorno e fragmentos são descartados. Outros caminhos de provedores permanecem inalterados. Copiar URL e fallback também utilizam o launcher.

O token continua vindo exclusivamente do polling OAuth do host. O servidor deve ser publicado antes desta versão. Popup bloqueado, JavaScript desabilitado ou aba externa com histórico que recuse fechamento mantêm orientação manual; não existe promessa de contornar restrições do navegador.

Validação: `npm run verify:package` aprovado, 765 testes, lint, formatação, typechecks, arquitetura e VSIX. Bundle 837,6 KiB dentro do teto existente. Testes verificam URL, remoção de dados não necessários, código inválido, providers distintos e apresentação no desktop/web/cópia/falha de abertura. No Identity: 1.179 testes e quatro testes Chrome, incluindo fechamento real da aba inicial e popup, recusa e mensagens inválidas. Referência em docs/DEVICE-FLOW-BROWSER.md.

Checkpoint de publicação em 10/09/2026, com ativação das janelas ainda pendente:

- Symposium: [PR #54](https://github.com/sufficit/sufficit-vscode-symposium/pull/54) integrado em develop/main (`dd502ae`), tag `v2026.910.1`. [Workflow 34507537794](https://github.com/sufficit/sufficit-vscode-symposium/actions/runs/34507537794) concluído com sucesso, incluindo Marketplace, Open VSX e [GitHub Release](https://github.com/sufficit/sufficit-vscode-symposium/releases/tag/v2026.910.1). API Open VSX confirmou a versão publicada.
- Identity: [PR #65](https://github.com/sufficit/sufficit-identity/pull/65) integrado em main (`58900b3`). Artefato do commit `992d9b7`, ancestral do merge, aplicado sequencialmente em eveo-apps, apoint-apps e castrum-apps. Os três serviços ficaram saudáveis, com o mesmo DLL, configuração e certificados preservados. Launcher PT/EN, cabeçalhos, discovery/JWKS e URL pública verificados. Backup em cada nó: `/opt/sufficit-identity.before-launcher-20260910T1720Z`.
- Standard: [PR #8](https://github.com/sufficit/sufficit-standard/pull/8) integrado em main (`abe1e50`), publicando as referências compartilhadas de configuração e identificação de requisições.

A validação de CI também exigiu explicitar o mapeamento NuGet de NATS.Client e converter links entre repositórios em links canônicos. Três alertas CodeQL (174, 29 e 30) foram examinados e dispensados como falsos positivos com justificativas: os valores registrados eram identificadores públicos de capabilities, não senhas ou outros segredos. As verificações passaram sem desativação de regras.

O VSIX validado foi instalado pelo CLI local e pelo code-server em development; ambos listam `2026.910.1`. SHA-256 do pacote local instalado: `8435dfe3a8d684227708e225256db07f58c65177428683bee4603be3965876f6`. SHA-256 do artefato Identity: `dd7cfb3ddff11b733c30439e9593c9fa2e4a77b616af14caf9df615ee2f9c9c1`.

A ativação nas janelas abertas **não está confirmada**. A janela local tinha turnos ativos e não foi interrompida. No code-server, o Extension Host de PID 1170996 foi encerrado somente após confirmar ociosidade, fila vazia e identidade do processo; ele não reiniciou automaticamente. É necessário recarregar essa janela e confirmar `activated version=2026.910.1` no log, conforme [RELEASE.md](../RELEASE.md). O serviço inteiro e outros hosts não foram reiniciados.

O plano ativo PLAN-device-popup-release.md permanece para acompanhar essa pendência; este registro não declara a ativação concluída. PLAN-live-retry.md pertence a outra atividade e foi preservado.
