# User-Agent nos clientes de transcrição

Padronização dos caminhos HTTP de áudio relacionados à investigação do
`OPTIONS /openai/v1/audio/transcriptions`. Os destinos, as credenciais e os
campos enviados pelas aplicações foram preservados.

| Cliente | Identificação | Entrega |
| --- | --- | --- |
| Symposium | `symposium-vscode`, já usado na consulta de modelos | Este commit |
| Mailbox Worker | `Sufficit-Mailbox-Worker` | `3d8b486` |
| Fleet | `Sufficit-Fleet/1.0`, já usado em outras integrações do Fleet | `ab1ee55` |
| n8n | `Sufficit-n8n` nas transcrições Whisper, Groq e OpenAI | `4ea83e9` |
| Android AI Gateway | `Sufficit-Android-AI-Gateway` em Whisper e ElevenLabs | `3ce79c5` |
| AI Playground | `Sufficit-AI-Playground` no User-Agent e em `X-Sufficit-Application` | `1ff5d806` |

O Genius Desktop já identifica suas transcrições como `Sufficit-AI-Genius`.
O cabeçalho de aplicação identifica o Playground quando o navegador controla
o User-Agent enviado.

A compilação TypeScript, cinco testes focados e os gates locais do Symposium
passaram. Os builds Release e os testes focados do Mailbox Worker, Fleet e
Sufficit AI passaram. A suíte unitária do Android passou. No n8n, a comparação
estrutural confirmou o novo cabeçalho em dez nós e a preservação de todos os
demais valores dos workflows. As alterações foram entregues na main de cada
repositório. Não houve deploy de aplicações nem importação de workflows ativos.
