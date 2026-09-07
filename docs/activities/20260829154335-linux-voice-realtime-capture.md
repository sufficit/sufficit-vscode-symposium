# Atividade — Captura de voz Linux e transcrição progressiva

> Data: 2026-08-29 15:43 (BRT)
> Status: concluída
> Release: v2026.829.1

## Sintomas

- no VS Code desktop Linux, o Symposium gravava por FFmpeg em um WAV crescente
  e só apresentava texto depois que o usuário encerrava a captura;
- não havia confirmação confiável de que o microfone realmente entregava
  áudio, medidor de nível ou identificação do provedor ativo;
- no caminho MediaRecorder, gravação e VAD podiam abrir dois streams do mesmo
  microfone, e conversões base64 grandes eram feitas byte a byte;
- respostas tardias de uma captura podiam alcançar uma captura seguinte sem
  identidade explícita para rejeitá-las.

## Referência arquitetural

Foi revisado o pipeline de áudio do Sufficit AI Genius. Foram aproveitados os
princípios que se aplicavam ao ambiente de extensão:

- fallback ordenado PipeWire, PulseAudio e ALSA;
- PCM mono de 16 kHz limitado em memória durante a captura;
- prontidão somente após o primeiro bloco real de áudio;
- telemetria RMS/pico, detecção de fala e silêncio;
- prévias segmentadas serializadas e uma transcrição final autoritativa;
- limites explícitos para abertura e encerramento do MediaRecorder.

## Implementação

- o host Linux tenta `pw-record`, FFmpeg/Pulse e `arecord`, nessa ordem, e
  libera completamente um provedor com falha antes de abrir o próximo;
- o áudio é mantido como PCM16 em buffer limitado a cinco minutos; o WAV
  canônico só é materializado para prévias ou para a transcrição final;
- cada captura recebe `captureId`, propagado por início, estado, prévia,
  silêncio, fala, parada, resultado e erro; eventos obsoletos são ignorados;
- o compositor mostra abertura, escuta, fala, finalização, erro e nível do
  microfone usando cores semânticas do tema e respeitando movimento reduzido;
- prévias são solicitadas durante a fala, reconhecidas mesmo quando ainda não
  há áudio suficiente e serializadas com a passagem final para evitar disputa
  de CPU entre dois processos Whisper;
- a transcrição final do áudio completo substitui a prévia e permanece como
  fonte autoritativa;
- MediaRecorder ganhou constraints de voz, seleção de Opus, chunks temporais,
  timeout de permissão, fallback de parada e base64 via FileReader;
- VAD e gravação local reutilizam o mesmo MediaStream, eliminando a segunda
  abertura do microfone;
- foi incluído `npm run smoke:voice` para confirmar provedores instalados.

## Testes e guardrails

- buffer PCM: fragmentação em bytes ímpares, recortes, limite, truncamento,
  RMS/pico, transições fala/silêncio e cabeçalho WAV;
- catálogo de provedores: ordem Linux, parâmetros PCM multiplataforma,
  descoberta de executáveis e ausência de DirectShow sem dispositivo;
- contrato de produção: correlação por captura, serialização das prévias,
  deadlines do MediaRecorder, formatos Opus, stream único de VAD e
  acessibilidade do indicador;
- 39 testes de voz e protocolo direcionados aprovados;
- suíte integral aprovada com cobertura, bundle webview, ESLint, typechecks,
  configuração, tamanho máximo, complexidade, engenharia e arquitetura;
- smoke local aprovou PipeWire, FFmpeg/Pulse e ALSA;
- auditoria visual não apontou nova ocorrência no componente de voz;
- os tetos medidos dos bundles foram recalibrados de 800/320 KB para 810/330
  KB após acréscimos de 4,2/5,3 KB, mantendo cerca de 5 KB de margem por
  artefato e o limite independente de 1 MB para o VSIX completo.
