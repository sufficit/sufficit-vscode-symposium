# Device Flow: abertura e fechamento do navegador

O login remoto/web do Symposium usa Device Flow. A URL
`/connect/device` do Identity é transformada em `/device/launch`, na mesma
origem, levando somente user_code e launch_mode=popup. Outros caminhos de
provedores mantêm a URL original. O ambiente do Identity precisa oferecer suporte ao launcher.

O launcher oferece **Abrir autenticação**. O clique abre um popup controlado
pela página de mesma origem do Identity; ela acompanha a conclusão, fecha o
popup e tenta fechar a própria aba. O Chrome permite esse fechamento quando
a aba externa permaneceu no documento inicial. Uma aba com histórico anterior
ou outra restrição do navegador mantém uma instrução manual. Popups bloqueados
oferecem continuidade na mesma aba; sem JavaScript o link continua normalmente.

Isso resolve a ausência de opener na abertura direta por vscode.env.openExternal
sem servidores loopback, tunnels adicionais ou mudanças no contrato OAuth.
O Device Flow continua buscando o token no host. Nenhum token, device_code,
URL de callback ou resultado autenticado é transmitido por postMessage.
Copiar URL e o fallback quando openExternal falha também usam o launcher.

[Contrato do servidor e casos de segurança](https://github.com/sufficit/sufficit-identity/blob/main/docs/design/DESIGN-DEVICE-FLOW-POPUP.md).
