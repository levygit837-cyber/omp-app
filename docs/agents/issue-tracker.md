# Issue tracker: GitHub

Issues e PRDs deste repo vivem como GitHub issues em `levygit837-cyber/omp-app`. Use a CLI `gh` para tudo.

## Convenções

- **Criar issue**: `gh issue create --title "..." --body "..."`. Use heredoc para corpo multi-linha.
- **Ler issue**: `gh issue view <número> --comments`, filtrando comentários com `jq` e buscando também os labels.
- **Listar issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` com filtros `--label` e `--state` conforme necessário.
- **Comentar**: `gh issue comment <número> --body "..."`
- **Aplicar / remover label**: `gh issue edit <número> --add-label "..."` / `--remove-label "..."`
- **Fechar**: `gh issue close <número> --comment "..."`

O repo é inferido de `git remote -v`; o `gh` faz isso sozinho dentro do clone.

## Pull requests como superfície de triage

**PRs como superfície de pedidos: não.** _(Mude para `sim` se o repo tratar PRs externos como pedidos de feature; `/triage` lê esta flag.)_

## Quando uma skill diz "publicar no issue tracker"

Crie uma GitHub issue.

## Quando uma skill diz "buscar o ticket"

Rode `gh issue view <número> --comments`.

## Wayfinding

Usado por `/wayfinder`. O **mapa** é uma issue única com **filhos** como tickets.

- **Mapa**: issue com label `wayfinder:map`, corpo com Notes / Decisions-so-far / Fog. `gh issue create --label wayfinder:map`.
- **Ticket filho**: issue ligada ao mapa como sub-issue (`gh api` no endpoint de sub-issues). Sem sub-issues, adicione o filho a uma task list no corpo do mapa e ponha `Part of #<mapa>` no topo do corpo do filho. Labels: `wayfinder:<tipo>` (`research`/`prototype`/`grilling`/`task`). Ao assumir, atribua ao dev responsável.
- **Bloqueio**: dependências nativas do GitHub. Aresta: `gh api --method POST repos/levygit837-cyber/omp-app/issues/<filho>/dependencies/blocked_by -F issue_id=<id-do-bloqueador>`, onde o id é o **database id** numérico (`gh api repos/levygit837-cyber/omp-app/issues/<n> --jq .id`, não `#número` nem `node_id`). `issue_dependencies_summary.blocked_by` conta só bloqueadores abertos. Sem suporte, use `Blocked by: #<n>, #<n>` no topo do corpo do filho. Livre quando todos os bloqueadores estiverem fechados.
- **Fronteira**: filhos abertos do mapa (`gh issue list --state open`), sem bloqueador aberto e sem assignee; vence a primeira na ordem do mapa.
- **Assumir**: `gh issue edit <n> --add-assignee @me`, primeira escrita da sessão.
- **Resolver**: `gh issue comment <n> --body "<resposta>"`, `gh issue close <n>`, depois acrescente um ponteiro (resumo + link) em Decisions-so-far do mapa.

## Templates

- Issues: formulários em `.github/ISSUE_TEMPLATE/` (`bug.yml`, `feature.yml`, `task.yml`). Issues em branco ficam desabilitadas em `config.yml`.
- PRs: `.github/pull_request_template.md` (Resumo, Evidência, Risco de merge).
- Ao criar issue via `gh issue create`, siga os campos do formulário correspondente; `gh` não aplica os forms sozinho.
