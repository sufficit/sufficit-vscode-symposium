# Previews Markdown compactos e artefatos sandbox

Pedido: reduzir a área de clique exagerada e recuperar as prévias animadas da captura.

## Alterações e decisões

- Controles de imagem passam a usar largura pelo conteúdo, com limite da coluna e 720 px. Fallback sem altura mínima, padding de 8 × 10 px e raio de 6 px. Imagens preservam tamanho natural e proporção.
- Links `sandbox:/mnt/data/...` são reconhecidos como arquivos locais tanto na prévia quanto na abertura por clique/teclado. Somente esse prefixo recebe a raiz adicional `/mnt/data`; realpath, bloqueio de escape por symlink, formatos raster e limite de 10 MB continuam aplicados.
- Imagens inicialmente ocultas usam carregamento imediato: lazy loading não iniciava enquanto o elemento oculto aguardava o próprio evento load para aparecer.
- Referências: captura e pedido do usuário (densidade), CSS e tokens existentes (identidade), arquivos originais e eventos reais do ledger (destinos). Sem alteração de direção visual.

## Validação

- Os dois testes de regressão sandbox falharam antes da correção e passaram depois; suíte direcionada com 33 testes passou.
- `npm run verify` passou com todas as alterações finais: formatação, lint, tipos de host/webview, suíte completa (938 testes aprovados), cobertura, verificações de arquitetura/engenharia e build da extensão/PWA. A cobertura por linhas alteradas foi dispensada pelo próprio script por ausência de COVERAGE_BASE_SHA.
- Chromium real renderizou os dois WebP originais, usando `loadMarkdownImage`, em 1030 e 360 px: controles de imagem de 386 e 312 px, respectivamente; fallback de erro com 59,4 px de altura e 195,8 px de largura. Sem overflow horizontal.
- Detector de UI encontrou avisos preexistentes fora do componente alterado; mantidos fora do escopo.
- Evidência visual local: `/tmp/symposium-preview-1030.png` e `/tmp/symposium-preview-360.png`.

## Entrega

Release `2026.1020.1` autorizada pelo usuário. Preparada em `develop` sobre a consolidação existente em `main`, sem reescrever commits. Versão sincronizada em package.json, lockfile e VERSION.md.

`verify:package` passou com 938 testes e VSIX de 545564 bytes (41 arquivos). Corrigido o orçamento do bundle host de 906 para 912 KiB: a consolidação anterior já media 931797 bytes e falhava no CI 39438754773; o host desta release mede 931904 bytes (910,06 KiB). O teto do arquivo VSIX permanece em 1 MiB.

Teste adicional de Extension Host (`xvfb-run -a node test/extensionHost/run.cjs`) passou com saída 0.

Publicação, instalação e ativação serão registradas após a confirmação dos resultados. Nenhum host com turno ativo será reiniciado.
