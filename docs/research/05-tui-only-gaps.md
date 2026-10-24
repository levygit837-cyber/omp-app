# Comandos TUI-only: como o desktop cobre cada um

Fonte e legenda: ver `01-surfaces.md`. Collab (`collab`, `join`, `leave`) está fora de escopo (ADR 0002) e não aparece abaixo.

## Contagem

Parse por regex dos arquivos `slash-commands/builtin-*.ts` e `seance.ts` `[V]`:

- 86 builtins no total.
- 46 têm `handle` (8 só `handle`, 38 com `handle` e `handleTui`). Rodam fora do TUI por `executeAcpBuiltinSlashCommand` (`slash-commands/acp-builtins.ts:59`).
- 40 só têm `handleTui`: `agents, branch, btw, cleanse, clear, collab, copy, debug, delete, exit, extensions, fork, git, goal, guided-goal, hotkeys, hub, join, leave, live, login, logout, loop, new, omfg, open, pause, plan, plan-review, queue, quit, record, restart, resume, settings, setup, skills, tan, tree, vibe`.

Mandar `/plan` por `prompt` não liga o plan mode: sem `handle`, o texto vai ao modelo `[V]`.

## Estratégia por comando

Classes: **ACP** (método ou config option), **SDK** (API pública do `AgentSession` ou módulo), **UI** (o desktop desenha a tela por conta própria), **PATCH** (nenhuma superfície alcança; ver `docs/patches.md`), **N/V** (conteúdo não lido).

| Comando | Classe | Como | Confiança |
|---|---|---|---|
| `new`, `resume`, `fork` | ACP | `newSession`, `resumeSession`/`loadSession`, `unstable_forkSession` | `[V]` |
| `queue` | ACP | `_session/steering` com `_meta.steering.queue` | `[V]` |
| `plan` | ACP + SDK | modo `plan` em `setSessionMode`, disponível se `plan.enabled`; ou `session.setPlanModeState` | `[V]` |
| `plan-review` | ACP | aprovação por elicitation (`Approve and execute` / `Refine plan`) | `[V]` |
| `pause` | SDK | `agentPauseGate.pause()` e `resume()` (`packages/agent/src/pause.ts:42,54`); vale para o processo inteiro | `[V]` |
| `clear` | SDK | `session.resetSessionContext()` (`agent-session.ts:6279`) | `[V]` |
| `vibe` | SDK + PATCH | `activateVibeTools`, `setVibeModeState`, `sendVibeModeContext` existem; a orquestração (`VibeSessionRegistry`, `interactive-mode.ts:~6170`) não foi lida | `[V]` métodos, `[S]` orquestração |
| `goal`, `guided-goal` | SDK + PATCH | `getGoalModeState` só lê (`agent-session.ts:7204`); ligar mora em `interactive-mode.ts:~6405/6449`; o RPC tem versão pronta em `modes/rpc/rpc-goal.ts` para copiar | `[S]` |
| `loop` | PATCH | estado só no `InteractiveMode` (`loopModeEnabled`, `handleLoopCommand`, `interactive-mode.ts:1330,3302`); sem equivalente em `AgentSession` | `[V]` |
| `delete` | SDK | compõe apagar o arquivo da sessão e `newSession`; o TUI usa `#runNewSessionFlow({drop:true})` | `[S]` |
| `btw` | SDK | `runEphemeralTurn` existe no `ExtensionContext` (`extensions/types.ts:750`); o RPC tem `btw`, `btw_cancel`, `get_btw_history` | `[V]` |
| `tree`, `branch` | SDK | `SessionManager`; o RPC expõe `get_tree`, `get_entries` | `[I]` |
| `login`, `logout`, `setup` | UI + SDK | tela própria sobre `AuthStorage`; entrada de segredo é do desktop | `[I]` |
| `live` | PATCH ou SDK | RPC tem `live_start/stop/mute` (`rpc-wire.schema.json:345`); ACP não | `[V]` |
| `settings`, `extensions`, `skills`, `agents`, `hub`, `git`, `copy`, `hotkeys`, `debug`, `open` | UI | telas do desktop; dados via `06-management.md` | `[S]` |
| `exit`, `quit`, `restart` | UI | ciclo de vida do processo é do app | `[S]` |
| `record` | fora | gravação de tela do TUI; sem valor no desktop | `[S]` |
| `tan`, `omfg`, `cleanse` | N/V | corpos dos controllers não lidos | `[I]` |

## Lacunas de observabilidade (não são comandos)

O ACP descarta estes eventos (`02-acp.md`): subagents, `queue_update`, `goal_updated`, `auto_compaction_*`, `auto_retry_*`, `notice`, `advisor_*`, `ttsr_triggered`, `irc_message`, `config_warnings_changed`. Um host que roda a sessão em processo pode assinar `AgentSession` direto e não perde nenhum. Ver ADR 0001.

## Não verificado

- Orquestração do vibe e do guided-goal.
- Corpos de `tan`, `omfg`, `cleanse` e de `chooseSeanceModel`.
- Se o `runtime` passado a um `handle` expõe UI suficiente para o plan mode no RPC.
