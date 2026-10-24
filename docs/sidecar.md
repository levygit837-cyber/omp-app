# Sidecar

Processo Bun que hospeda o omp para o Electron. Hoje existe só a versão do spike (`spike/sidecar.ts`, 194 linhas, descartável). Este doc descreve o contrato que o spike provou; o sidecar do app herda dele. Decisão e motivos: `adr/0001-integracao-acp-sdk-patches.md`.

Legenda: `[V]` conferido no código do spike ou do omp; `[I]` inferência.

## Como rodar

- Sidecar sozinho: `bun spike/sidecar.ts <caminho-do-socket>` `[V]`.
- Sidecar + cliente Node que faz o papel do Electron: `cd spike && node client.mjs [cenario...]` `[V]`.
- Cenários de `client.mjs`: `basic isolation clear steering subagent mcp ask plan planApproval reject cancel cancelSubagent` `[V]`.
- Pré-requisitos do checkout do omp (`bun install`, symlink do `.node`): `spike.md`, seção "Preparação do checkout".

## Variáveis de ambiente

| Variável | Padrão | Efeito |
|---|---|---|
| `OMP_SRC` | `~/Developer/bigbang-deps/oh-my-pi/packages` | Raiz dos pacotes do omp. Os imports são dinâmicos porque o caminho só é conhecido em runtime `[V]` |
| `SPIKE_MODEL` | `claude-haiku-5.5` | Id do modelo do provider `kiro`. O sidecar falha se não achar `[V]` |

## Canais

| Canal | Direção | Formato | Uso |
|---|---|---|---|
| `stdin`/`stdout` | Electron ⇄ sidecar | ACP em ndJSON | Protocolo oficial: `session/new`, `session/prompt`, `session/cancel`, `elicitation/create`, `session/request_permission` `[V]` |
| `stderr` | sidecar → Electron | texto | Logs. `console.log` é redirecionado para cá, porque `stdout` é do ACP `[V]` |
| Unix socket (`chmod 600`) | Electron ⇄ sidecar | ndJSON, uma mensagem por linha | Canal lateral: eventos diretos da `AgentSession` e comandos que o ACP não tem `[V]` |

Regra: nada além de ACP pode sair em `stdout`. Qualquer `print` perdido corrompe o protocolo `[I]`.

## Canal lateral: mensagens do sidecar para o cliente

| `kind` | Campos | Quando |
|---|---|---|
| `session` | `sessionId`, `agentId` | Uma sessão foi criada pela factory |
| `event` | `sessionId`, `type`, `sub` (tipo do `assistantMessageEvent`), `queue` (`steering`, `followUp`, só em `queue_update`) | Todo evento da `AgentSession`, sem o filtro do mapper ACP |
| `subagent` | `sessionId`, `subagentId`, `type` | Frame de subagent vindo de `subagentEventBus`, canal `task:subagent:event` |
| `reply` | `id`, `res` ou `error` | Resposta a um comando |

Tipos de `event.type` que o spike viu: `agent_start`, `turn_start`, `message_*`, `turn_end`, `agent_end`, `queue_update`. A lista completa é o tipo `AgentSessionEvent` (ver `agents/omp-reference.md`) `[V]`.

## Canal lateral: comandos do cliente para o sidecar

Cada comando é `{ id, cmd, sessionId? }`. A resposta volta como `kind: "reply"` com o mesmo `id`.

| `cmd` | Retorno | Observação |
|---|---|---|
| `state` | `{ paused, sessions: [{ id, messages, streaming, model }] }` | |
| `pause` | `{ changed, paused }` | `agentPauseGate`: global ao processo, não é o ESC |
| `resume` | `{ resumedAfterMs, paused }` | |
| `planState` | `{ plan }` (`null` se fora do plan mode) | exige `sessionId` |
| `tools` | `{ tools: string[] }` | `getAllToolNames()`; exige `sessionId` |
| `clear` | `{ ok, result, messages }` | `resetSessionContext()`; exige `sessionId` |

Comando desconhecido ou `sessionId` inexistente devolve `{ error }` `[V]`. Os 6 comandos são o que o spike precisou; o sidecar do app terá mais (ver "Superfície a expor").

## Factory de sessões

O sidecar monta a factory à mão e passa a `createAcpConnection(transport, factory)` (`modes/acp/acp-mode.ts`) `[V]`. A cada `session/new`, ela:

1. Clona `Settings` para o `cwd` recebido (`settings.cloneForCwd`).
2. Cria `SessionManager.inMemory()` e o `agentId` `acp:<sessionId>`.
3. Cria um `EventBus` e um `subagentEventBus` próprios da sessão.
4. Chama `createAgentSession({ cwd, sessionManager, settings, authStorage, modelRegistry, model, thinkingLevel, agentId, interactivePrompts, deferUsageReserveConfirmation: true, enableMCP: false, eventBus, subagentEventBus })`.
5. Guarda a sessão em `sessions` (`Map<sessionId, AgentSession>`), assina `subscribe` e `subagentEventBus` e repassa tudo ao canal lateral.
6. Devolve `{ session, setToolUIContext }`.

Pontos de atenção:

- `enableMCP: false`: o disco de MCP é ignorado; só vale `session/new.mcpServers` `[V]`.
- `ensureTheme()` de `@oh-my-pi/pi-tui/theme` é obrigatório no startup. Sem ele a tool `ask` falha `[V]`.
- O spike fixa modelo e `thinkingLevel: "low"` e usa `SessionManager.inMemory()`. O app terá sessão em arquivo (`SessionManager` padrão) e modelo por aba `[I]`.
- O spike tipa só o que usa (`SpikeSession`). O app deve tipar a partir de `AgentSession`, sem `any`.

## Superfície a expor (o que o app vai precisar além do spike)

Mapa do que já existe no omp para cada necessidade; o motivo e as linhas estão nos docs de pesquisa.

| Necessidade | Onde está | Doc |
|---|---|---|
| Parar a aba (ESC) | `session/cancel` | `spike.md` (resultado `cancel`) |
| Matar job ou subagent | `AsyncJobManager.cancelAll({ ownerId })`, `asyncJobManager` na sessão | `adr/0001`, decisão de 2026-10-24 |
| Plan, vibe, goal, loop | métodos públicos do `AgentSession`; loop e goal exigem patch | `research/04-sdk.md`, `patches.md` |
| Steering/follow-up | `_session/steering` com `_meta.steering.queue` | `research/02-acp.md` |
| Sessões, projetos, uso, extensões | `extMethod` do ACP: `_omp/sessions/listAll`, `_omp/projects/list`, `_omp/chats/byCwd`, `_omp/usage`, `_omp/extensions`, `_omp/extensions/toggle` | `research/02-acp.md` |
| Settings, MCP, skills, plugins | CLI com `--json`, `Settings`, `mcp/config-writer.ts` | `research/06-management.md` |

Os métodos `_omp/*` estão em `modes/acp/acp-agent.ts:1418-1491` `[V]`.
