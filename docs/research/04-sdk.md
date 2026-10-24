# SDK do omp

Fonte e legenda: ver `01-surfaces.md`. Spec do omp: `docs/sdk.md` no checkout (`omp://sdk.md`). Este doc guarda só o que importa para o desktop.

## Restrições de runtime

- Requer Bun 1.3.14 ou superior `[V]`.
- O `package.json` exporta código-fonte TypeScript, sem build: `"import": "./src/index.ts"` (`packages/coding-agent/package.json:52-55`) `[V]`. Node não importa isso direto.
- `[I]` O processo principal do Electron roda Node. O SDK exige um sidecar Bun, e esse sidecar fala com o app por IPC.

## Entradas

- `createAgentSession(options)` devolve `{ session, extensionsResult, setToolUIContext, mcpManager, eventBus, subagentEventBus, ... }` `[V]`.
- Para várias sessões top-level no mesmo processo, passar um `AgentRegistry` privado a cada uma. O registry global admite uma única identidade `"Main"` `[V]`.
- Estado de processo seguido pela sessão mais nova: efeitos de settings (tema, limites de request) e toggles de discovery. Sessões com `bindProcessState: false` não o tomam `[V]`.
- `MCPManager` tem instância global por processo (`static #instance`, `mcp/manager.ts:182`) `[V]`.

## Subpaths importáveis

`package.json` exporta `"./*": "./src/*.ts"` e wildcards específicos `[V]`: `./config/*`, `./mcp`, `./mcp/*`, `./modes`, `./modes/*`, `./modes/acp`, `./modes/acp/*`, `./extensibility/*`.

Consequência: qualquer módulo em `src/` é importável, incluindo `config/registry.ts`, `mcp/config-writer.ts` e `modes/acp/acp-agent.ts`.

## Métodos públicos do `AgentSession` que cobrem comandos TUI-only

| Método | Cobre | Linha em `session/agent-session.ts` |
|---|---|---|
| `setPlanModeState`, `getPlanModeState`, `setPlanProposalHandler` | `/plan` | 7190, 4489, 2964 `[V]` |
| `activateVibeTools`, `deactivateVibeTools`, `setVibeModeState`, `getVibeModeState`, `sendVibeModeContext`, `runModeExitTeardown` | `/vibe` | 6769, 6774, 7216, 7212, 7405, 8981 `[V]` |
| `getGoalModeState` | leitura de `/goal` | 7204 `[V]` |
| `resetSessionContext()` | `/clear` | 6279 `[V]` |
| `freshSession()` | `/fresh` | 6245 `[V]` |

Fora do `AgentSession`:

- `agentPauseGate` (`pause()`, `resume()`, `paused`) é exportado por `@oh-my-pi/pi-agent-core` (`packages/agent/src/pause.ts:25-107`) e cobre `/pause`. O gate vale para o processo inteiro `[V]`.
- Estado do loop mode vive no `InteractiveMode` (`modes/interactive-mode.ts:3294-3332`), não no `AgentSession` `[V]`.

## `Settings`

- Métodos: `get`, `set`, `override`, `clearOverride`, `flush`, `reloadForCwd`, `setModelRole`, `getModelRoles`, `startWatching`, `stopWatching`, `reloadFromDisk` (`config/settings.ts`) `[V]`.
- `startWatching()` só age na instância global (`globalInstance === this`) `[V]`.

## Limites do SDK

- Eventos de sessão em `AgentSessionEvent`: lista em `docs/sdk.md` seção "Event subscription model" `[V]`.
- Collab depende de `InteractiveModeContext` e não é alcançável pelo SDK (ADR 0002) `[V]`.
