# Abertura de sessões longas

O chat abre pelo trecho recente. Se há `render.jsonl`, ele é a fonte visual canônica: contém mensagens do usuário, ferramentas, diffs e avisos que a transcrição nativa do adaptador pode omitir. A primeira página e as seguintes usam offsets de bytes desse mesmo arquivo; não se alterna para o JSONL nativo no meio da paginação. Sem render log, aplica-se a paginação própria do adaptador.

`readRenderPage` procura uma fronteira de mensagem do usuário e devolve um turno completo, até o offset solicitado. A meta é cerca de 1 MB por página, mas um turno individual pode ultrapassá-la. O cursor da página anterior continua estável quando outro processo acrescenta registros ao final. Linhas incompletas não são projetadas; o seguidor as lê quando terminam.

Ao retomar, o controller semeia somente a página recente no stream. Fila e plano atuais são recuperados separadamente, buscando o último retrato de cada um nas páginas anteriores sem enviar esses eventos históricos à interface. O estado visual do plano chega em `todos-snapshot`. A projeção AHP usa IDs de turno com namespace de página para não descartar páginas anteriores por colisão. A rolagem para cima libera sua trava após cada resposta e pode solicitar a próxima página.

Durante a hidratação, turnos e ferramentas antigas são pintados como histórico: não alternam o estado ocupado do compositor nem reiniciam animações de conclusão de tarefas. Eventos novos mantêm as transições normais. Testes principais: `src/test/renderLog.test.ts`, `src/test/historyPageIdentity.test.ts` e `test/webviewDom.test.cjs`.

Limite conhecido: quando o último turno sozinho é grande, a página inicial também cresce para preservar a integridade desse turno. A recuperação inicial de planos/filas de logs antigos pode precisar percorrer páginas anteriores; essas páginas não são enviadas ao webview.
