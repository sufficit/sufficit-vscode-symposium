# Processo de Desenvolvimento

```text
1. Criar ou identificar a issue
2. Marcar a issue como WIP quando o desenvolvimento começar
3. Trabalhar na única pasta da sessão
4. Criar uma branch exclusiva para a atividade
5. Desenvolver, testar e commitar
6. Abrir PR para develop
7. Marcar como Ready for review quando concluir
8. Resolver os comentários na mesma branch
9. Teste de regressão
10. Hugo realiza o merge; atualizar e fechar a issue
```

---

## 1. Pasta da sessão

Existe uma **única pasta por conversa/sessão**, por exemplo:

```text
sufficit-vscode-symposium
```

- Não deve ser criada uma pasta nova para cada issue ou PR.
- Todos os trabalhos da sessão usam essa mesma pasta. O que muda é apenas a branch.

---

## 2. Issue

Antes de desenvolver:

- Procurar se já existe uma issue equivalente;
- Reutilizar a issue existente quando possível;
- Criar uma nova somente se necessário;
- Descrever objetivo, contexto, escopo e critérios de aceite;
- Relacionar issues e PRs dependentes.

Quando o desenvolvimento começar, a issue deve receber a label `wip` e identificar agente, sessão e pasta:

```text
🚧 WIP - <agente>/<atividade> · sessão <session-id> · pasta <nome-da-pasta> · atividade
```

> Se for apenas registrar uma demanda, sem iniciar desenvolvimento, não é necessário criar branch, PR ou marcar como WIP.

---

## 3. Branch

No projeto, a branch de integração é `develop`.

Antes de criar uma branch nova:

```bash
git fetch origin
git switch develop
git pull --ff-only origin develop
git switch -c <agente>/<atividade>-<session-id>
```

Exemplo:

```bash
git switch -c antigravity/gemini-filter-2bb448d0-3917-46fc-83df-3cc1a15f768b
```

- Cada atividade deve ter sua própria branch.
- Não se cria uma pasta nova para cada atividade. Depois de finalizar uma atividade, volta-se para `develop` e cria-se outra branch na mesma pasta.

---

## 4. Desenvolvimento & Guardrails

O código deve ser alterado somente na branch da atividade.

No projeto `sufficit-vscode-symposium`:

- Manter mudanças de código dentro de `src/` e documentações em `docs/`;
- Não misturar tarefas diferentes na mesma branch;
- Preservar alterações de outras sessões;
- Usar commits pequenos, atômicos e objetivos;
- Respeitar os limites de complexidade e tamanho de arquivos do repositório (máximo 400 linhas por arquivo, complexidade ciclomática <= 15);
- Executar lint, testes focados, typecheck e verificação de integridade antes do commit.

Antes do commit:

```bash
git status
git diff --check
git diff
npm run verify
```

---

## 5. Pull Request

Depois de desenvolver e validar:

```bash
git push -u origin <agente>/<atividade>-<session-id>
```

A PR deve:

- Apontar para `develop`;
- Referenciar a issue com `Refs #N` ou `Closes #N`;
- Informar detalhadamente os testes executados (comandos e resultados);
- Informar limitações ou validações pendentes;
- Permanecer como `Draft` enquanto estiver incompleta.

Assim que a implementação e os testes estiverem concluídos, a PR deve ser marcada como **`Ready for review`** e encaminhada para o Hugo.

---

## 6. Revisão

Se aparecer `CHANGES_REQUESTED`:

- Corrigir os apontamentos na mesma branch;
- Fazer novos commits;
- Enviar novamente para a mesma PR (`git push origin <branch>`);
- Executar novamente os testes (`npm run verify`);
- Solicitar nova revisão.

> Não se cria uma PR nova para cada comentário de revisão. A decisão de aprovação é feita pelo revisor.

---

## 7. Merge

O merge **não é automático**:

1. A PR é revisada;
2. Os bloqueios/comentários são corrigidos na branch;
3. A PR é marcada como `Ready for review`;
4. **O Hugo é o responsável por aprovar e realizar o merge para `develop`**.

Depois do merge:

- Adicionar comentário final na issue informando a conclusão e link da PR;
- Remover a label `wip`;
- Fechar a issue, caso ela não seja fechada automaticamente;
- Manter o histórico limpo.

---

## Regra Resumida

- **Uma pasta por sessão.**
- **Uma branch por atividade.**
- **Uma PR por branch.**
- **Envia ao Hugo para ele fazer o merge.**
