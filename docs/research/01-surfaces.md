# Superfícies de integração com o omp

Fonte: omp 18.12.6, checkout `~/Developer/bigbang-deps/oh-my-pi` no commit `0b5c27ab24` (2026-10-22). Caminhos de código são relativos a `packages/coding-agent/src` salvo indicação. Reconferir após qualquer `git pull` no checkout.

Caminhos `docs/...` dentro de `docs/research/` apontam para a doc do omp no checkout (`docs/approval-mode.md`, `docs/mcp-config.md`, `docs/sdk.md`, `docs/rpc.md`), não para os docs deste projeto. Os docs deste projeto são citados por nome relativo (`02-acp.md`, `../patches.md`).

Legenda de confiança, usada em todos os docs de `docs/research/`:

- `[V]` verificado lendo o código ou a doc do omp.
- `[S]` relatado por subagent de leitura e não conferido. Tratar como pista.
- `[I]` inferência. Nenhuma leitura sustenta.

## As superfícies

| Superfície | Como liga | Processo | Sessões | Runtime exigido |
|---|---|---|---|---|
| ACP | `omp acp` ou `omp --mode acp`, ndJSON em stdio `[V]` | 1 processo | N por processo (`#sessions`, `modes/acp/acp-agent.ts:791`) `[V]` | binário `omp` |
| SDK | `createAgentSession()` de `@oh-my-pi/pi-coding-agent` `[V]` | no processo do host | N, cada uma com `AgentRegistry` próprio (`docs/sdk.md`) `[V]` | Bun >= 1.3.14; o pacote exporta `.ts` cru (`package.json:52-55`) `[V]` |
| RPC | `omp --mode rpc` ou `rpc-ui`, JSONL em stdio `[V]` | 1 por sessão | 1 | binário `omp` |
| json | `omp -p --mode json` `[V]` | 1 por execução | 1 | binário `omp` |
| Collab | `/collab`, relay cifrado `[V]` | sessão TUI existente | n/a | fora de escopo (ADR 0002) |

Decisão do projeto: SDK + ACP + patches (ADR 0001). RPC fica como referência de código e de schema (`03-rpc-reference.md`).

## Matriz de cobertura

`sim` = há comando, método ou evento. `não` = confirmado ausente. `n/v` = não verificado.

| Função | ACP | SDK | RPC (referência) |
|---|---|---|---|
| prompt, abort | `prompt`, `cancel` `[V]` | `session.prompt`, `abort` `[V]` | sim `[V]` |
| steer e follow-up | ext `_session/steering` com `_meta.steering.queue` `[V]` | `steer()`, `followUp()` `[V]` | sim `[V]` |
| remover ou promover item da fila | não encontrado | n/v | `remove_queued_message`, `promote_queued_message` `[V]` |
| evento `queue_update` | descartado `[S]` | sim `[V]` | sim `[V]` |
| modelo e thinking | config options `model`, `thinking` `[V]` | sim `[V]` | sim `[V]` |
| nova, listar, retomar, fork, fechar sessão | `newSession`, `listSessions`, `resumeSession`, `loadSession`, `unstable_forkSession`, `closeSession` `[V]` | `SessionManager` `[V]` | sim `[V]` |
| árvore e entradas da sessão | não encontrado | `SessionManager` `[I]` | `get_tree`, `get_entries` `[V]` |
| plan mode | modo `plan` quando `plan.enabled` `[V]` | `get/setPlanModeState` `[V]` | não (`/plan` é TUI-only) `[V]` |
| vibe mode | não | métodos públicos no `AgentSession` `[V]` | não |
| goal mode | evento descartado; `/goal` TUI-only `[S]` | `getGoalModeState` `[V]` | `goal`, `goal_updated`, `rpc-goal.ts` `[V]` |
| `/btw` | não (TUI-only) `[V]` | `runEphemeralTurn` existe no `ExtensionContext` `[V]` | `btw`, `btw_cancel` `[V]` |
| subagents (listar, steer, cancelar, eventos) | não (nenhum `subagent` em `modes/acp/`) `[S]` | `AgentRegistry`, `subagentEventBus` `[V]` | sim `[V]` |
| todos e plano | `plan` sessionUpdate via tool `todo` `[S]` | sim | `set_todos` `[V]` |
| eventos de compaction e retry | descartados `[S]` | sim | sim |
| custo e contexto | `usage_update` só no `agent_end`; ext `_omp/usage` `[S]` | sim | `get_session_stats` `[V]` |
| aprovação de tools | `session/request_permission` para `bash`, `edit`, `delete`, `move` `[S]` | n/v | via extension UI `[V]` |
| perguntas do `ask` | elicitation `form` do cliente; sem ela retorna vazio `[S]` | `setToolUIContext` `[V]` | `set_ask_dialog` `[V]` |
| tools do host | n/v | `customTools` `[V]` | `set_host_tools` `[V]` |
| MCP | do cliente, via `session/new.mcpServers`; disco ignorado `[V]` | `enableMCP` e `MCPManager` `[V]` | do disco `[V]` |
| settings recarregam ao editar o arquivo | não (watcher só em rpc, rpc-ui e interativo, `main.ts:2654`) `[V]` | n/v | sim `[V]` |
| builtins com `handle` (46) | via `prompt "/cmd"` `[S]` | n/v | via `prompt "/cmd"`, saída em `command_output` `[V]` |
| builtins só TUI (40) | indisponíveis | n/v | indisponíveis |

Leitura da matriz: o ACP cobre sessão, plan mode, aprovação, steering e MCP. Ele perde observabilidade (subagents, fila, goal, compaction) e vários comandos. O SDK alcança estado interno que nenhuma superfície de protocolo expõe, mas só em processo com Bun.

## Extension API não serve de ponte

O `ExtensionContext` e o `ExtensionAPI` (`extensibility/extensions/types.ts:671-1965`) `[V]` oferecem `registerTool`, `registerCommand`, `sendMessage`, `sendUserMessage`, `setModel`, `setActiveTools`, `getCommands`, `appendEntry`, `exec`, `events` e, no contexto de comando, `newSession`, `branch`, `navigateTree`, `switchSession`, `reload`, `compact`.

Não oferecem: ligar plan mode, vibe, loop ou pause, nem escrever settings. Em plan mode só existem `resolvePlanReview`, `getPendingPlanReview` e `openPlanReview`, que respondem a uma revisão já aberta.

## Subcomandos CLI de gestão

Ver `06-management.md`. Não há subcomando `omp mcp` `[V]`.
