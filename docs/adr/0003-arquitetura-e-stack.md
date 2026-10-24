# 0003: Arquitetura do app e stack da v1

Status: aceita, decisões do usuário em sessão de grilling (2026-10-24). Spec publicada na issue #3; tickets #4 a #19.

## Contexto

- ADR 0001 fixou SDK + ACP + patches, com o omp hospedado num sidecar Bun. Esta ADR confirma essa base e decide o resto: dados, protocolo, estado, shell, UI, repo, build, plataforma e ordem de trabalho.
- O omp publicou 140 tags nos últimos 90 dias (contado no checkout de referência). O sidecar importa `src/*` do omp, não uma API estável.
- O `agent.db` tem `SCHEMA_VERSION = 6` (`session/agent-storage.ts:166`). Se o banco estiver mais novo que o omp, só emite `logger.warn` e segue; se estiver mais velho, migra e regrava a versão (`agent-storage.ts:353-364`) `[V]`.
- No spike, o ACP e o canal lateral entregavam eventos da mesma sessão por dois streams separados (`docs/sidecar.md:21-41`); o renderer teria que deduplicar e ordenar entre eles `[I]`.

## Decisões

### Integração

- Base do ADR 0001 confirmada.
- O sidecar trava uma versão exata do omp no npm (`@oh-my-pi/pi-coding-agent`, hoje `18.12.6`).
- Atualizar o omp é um bump deliberado, em 4 passos:
  1. Subir o pin.
  2. Rodar a suíte de contrato.
  3. Reconferir os `file:line` citados nos docs.
  4. Ler o changelog e abrir issue para cada feature nova que valha a pena.
- Patches (P1 a P3) vão upstream primeiro e nunca ficam no caminho crítico da v1.

### Dados

- O app compartilha o `~/.omp` com o CLI: sessões, credenciais, MCP, skills e settings são os mesmos.
- Guarda de schema no startup do sidecar: se o `agent.db` estiver mais novo que o omp travado, o app entra em modo só leitura e mostra um aviso.

### Protocolo

- O protocolo app⇄sidecar é do próprio app, tipado num pacote sem dependências. O renderer não conhece ACP nem tipos do omp.
- O `AcpAgent` roda dentro do sidecar, ligado por um transport em memória, e serve só como motor de controle.
- A timeline vem de uma fonte única: a assinatura direta da `AgentSession` e do `subagentEventBus`.
- O canal único substitui o par ACP + Unix socket do spike.

### Estado

- O sidecar é dono do estado canônico.
- Um reducer puro converte `AgentSessionEvent` no view model da sessão.
- Sincronização:
  - Ao assinar, o renderer recebe um snapshot com `seq`. Depois, recebe ops ordenadas.
  - Se faltar um `seq`, o renderer pede um snapshot novo.
- O renderer é uma réplica: store Zustand, seletores finos e deltas de token aplicados uma vez por frame.

### Stack

| Camada | Escolha | Por que não as alternativas |
|---|---|---|
| Shell | Electron | Electrobun: jovem e usa WebKit por padrão no macOS. Tauri: webview varia por SO e adiciona Rust |
| Renderer | React 19 + TypeScript | SolidJS e Svelte: ecossistema menor e suporte fraco do Pencil e dos agentes |
| Componentes | shadcn/ui sobre Base UI, código dentro do repo | Radix deixou de ser o padrão do shadcn em jul/2026 ([changelog](https://ui.shadcn.com/docs/changelog/2026-07-base-ui-default)) |
| Styling | Tailwind CSS v4, tokens via `@theme` | CSS Modules: menos fluência de agentes e Pencil |
| Package manager | Bun workspaces, um lockfile; `electron` em `trustedDependencies` | pnpm: dois gerenciadores, porque o sidecar exige Bun de qualquer forma |
| Build | electron-vite + electron-builder | Plugin Vite do Forge é experimental desde a v7.5.0 ([doc do Forge](https://www.electronforge.io/config/plugins/vite)) |
| Plataforma da v1 | macOS arm64 | Polimento concentrado num alvo. Código de macOS só no `main`, atrás da interface `platform` |

### Repo

```
apps/desktop        Electron: main, preload, renderer
packages/protocol   tipos e schemas, sem dependências
packages/sidecar    Bun; único pacote que importa omp; reducer e fixtures
packages/ui         tokens e componentes; não conhece protocol nem omp
design/omp.pen      versionado no git
```

Regras de dependência aplicadas por lint:

- `protocol` não depende de nada.
- `sidecar` depende de `protocol` e do omp.
- `ui` não conhece nada específico do app.
- `desktop` depende de `protocol` e `ui`, nunca do omp.
- O renderer não importa nada de Node.

### Design

- O código é a fonte da verdade: `tokens.css` e os componentes do pacote `ui`.
- O Pencil é onde se exploram UI/UX, detalhes, ícones e a visão geral.
- Os dois lados podem ser editados. O sync é manual, sem regra de PR. Se divergirem, vale o código.

### Testes

- Seam 1, o protocolo do sidecar, em dois modos:
  - Replay: eventos gravados do omp real, golden tests rodando no CI.
  - Live: omp real e modelo real, com os cenários do spike. Roda localmente e a cada bump.
- Seam 2, o store da réplica: streams de ops gravados.
- Sem testes de componente nem E2E de UI na v1. A UI se prova por smoke no app real.

### Ordem de trabalho

- Duas trilhas em paralelo:
  - Esqueleto ponta a ponta, com UI crua (#4 a #8).
  - Direção visual no Pencil (#9).
- Depois, fatias verticais (#10 a #19).
- A v1 é o "daily driver": o ponto em que o desktop substitui a TUI no uso diário.

## Consequências

- `docs/sidecar.md` descreve o contrato do spike. O sidecar do app herda dele a factory, a disciplina de stdout e o `ensureTheme()`. Os canais e comandos são substituídos pelo protocolo do app.
- A distribuição do Bun está resolvida: o sidecar sai como binário único, gerado com `bun build --compile` e embutido via `extraResources`.
- Fora da v1, cada item num marco próprio:
  - Assinatura, notarização e auto-update. Exigem Apple Developer ID.
  - Linux e Windows.
  - Goal, loop e vibe.
  - `/btw`, árvore e branch, voz, OAuth, `/pause` e `record`.
  - Collab segue fora (ADR 0002).
- Riscos ainda abertos:
  - O `electron-builder` com `node_modules` instalado pelo Bun (validado em #4).
  - Entitlements de JIT do binário do sidecar ao assinar `[I]`.
  - O canal de saída dos builtins no ACP (verificado em #17).
