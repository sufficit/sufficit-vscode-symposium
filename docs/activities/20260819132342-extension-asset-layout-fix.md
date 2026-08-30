# Atividade — compatibilidade dos assets no bundle do Extension Host

- Data: 2026-08-19 13:23:42 (America/Sao_Paulo)
- Escopo: carregamento de `webview.css` e `webview.bundle.js`
- Status: concluída

## Diagnóstico

O teste de Extension Host da `develop` revelou que os módulos compilados usam
`__dirname=out/ui`, enquanto o bundle final usa `__dirname=out`. O caminho
único fazia o bridge falhar com `ENOENT` em um dos ambientes.

## Correção e validação

Foi criado `src/ui/bundleAsset.ts`, que tenta o layout compilado e então o
layout empacotado `out/ui`. `chatClient` e `chatStyles` passaram a usar esse
leitor comum. O teste local `npm run test:extension-host` passou com código 0.

Essa correção será publicada na versão seguinte, sem mover a tag já publicada.
