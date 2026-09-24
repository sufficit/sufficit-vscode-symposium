# Atividade — HTTP 401 no meio de turno Sufficit AI

## Evidência

- A captura de 2026-09-24 corresponde ao turno 138 da seção fleet
  `8deacc70-53b4-445d-9d2a-b009f3396870`. O ledger preserva várias
  ferramentas concluídas antes do erro.
- O adaptador recebeu HTTP 401, pediu renovação e exibiu “authorization
  refreshed; retrying once”; a segunda requisição também recebeu HTTP 401.
  O corpo da resposta não trouxe uma causa mais específica.
- A implementação de Identity devolvia o token antigo após falha da renovação
  forçada se ele ainda não havia expirado pelo relógio local. Assim, o aviso
  “renovado” podia ser falso e a repetição usava a mesma credencial rejeitada.
  Não há evidência suficiente para afirmar que esse caminho específico ocorreu
  no incidente; um token novo também pode ter sido recusado pelo gateway.

## Correção

- Uma renovação forçada não reutiliza o mesmo token rejeitado. O adaptador só
  repete a requisição com uma credencial de acesso diferente e informa quando
  não conseguiu renová-la.
- Se o HTTP falhar após executar ferramentas, o erro mantém os resultados
  salvos, não oferece replay do pedido original e instrui o usuário a
  autenticar-se novamente (quando necessário) e enviar “Continue”.
- A apresentação do HTTP 401 distingue uma falha antes do trabalho de uma
  falha depois das ferramentas. A mesma proteção de replay vale para erros
  HTTP transitórios após ferramentas.

## Validação

- Regressões para token inalterado, token renovado ainda rejeitado, falha
  transitória após ferramentas e mensagem de erro contextual passaram.
- `npm run verify` e `npm run verify:package` passaram. Pacote
  `sufficit-vscode-symposium-2026.924.1.vsix`: 41 arquivos, 527.780 bytes.
- A validação real da seção depende de ativar a versão instalada numa janela
  sem turno em andamento e de uma nova ocorrência/requisição. Não foi
  repetido o pedido original do usuário nem alterado seu ledger.
