# ACP no omp

Fonte e legenda: ver `01-surfaces.md`. Caminhos relativos a `packages/coding-agent/src`. Linhas marcadas com `~` são aproximadas.

## Como liga

- `omp acp` força `mode: "acp"` e delega ao fluxo de launch normal (`commands/acp.ts:30-33`) `[V]`. `omp --mode acp` é equivalente.
- `acp` está em `LAUNCH_FLAG_COMMANDS`, então flags de launch antes do subcomando valem (`omp --approval-mode=yolo acp`) (`cli-commands.ts:313`, `~451`) `[V]`.
- Transporte: ndJSON sobre stdio com `AgentSideConnection` e `ndJsonStream` de `@oh-my-pi/pi-utils/acp` (`modes/acp/acp-mode.ts:4,89-91`) `[V]`.
- `@oh-my-pi/pi-utils/acp` é uma reimplementação própria do SDK ACP ("Behavior-compatible reimplementation of @agentclientprotocol/sdk's used surface", `packages/utils/src/acp.ts:1`) `[V]`. O cliente do desktop pode usar o SDK oficial, mas a compatibilidade é por comportamento, não por código compartilhado. Testar contra o `omp` real.
- `AcpAgent` é exportado (`modes/acp/acp-agent.ts:787`), com `constructor(connection, createSession, initialSession?)` `[V]`. A factory `AcpSessionFactory` devolve `AgentSession` ou `{ session, setToolUIContext }` (`acp-mode.ts:10-24`) `[V]`. Um host Bun pode, portanto, rodar o `AcpAgent` em processo e guardar as `AgentSession` que a factory criou. Detalhe em `docs/adr/0001`.
- `isolateProtocolStdout` redireciona qualquer escrita espúria em stdout para stderr, para não corromper o canal (`acp-mode.ts:43-58`) `[V]`.
- `hasUI` é falso e `settingsApproval` é falso no ACP (`main.ts:2281-2283`) `[S]`.
- `PI_NO_TITLE` e `PI_NO_PTY` são definidos por flags e por modo (`main.ts:1965-1974`) `[S]`.
- Flag `--acp-terminal-auth` abre o TUI no mesmo comando (`modes/acp/terminal-auth.ts:1`) `[S]`.

## Hospedagem de sessões

- Um processo guarda `#sessions: Map<string, ManagedSessionRecord>` (`modes/acp/acp-agent.ts:791`) `[V]`.
- `cwd` deve ser absoluto em `newSession`, `loadSession`, `resumeSession` e `forkSession` (`#assertAbsoluteCwd`) `[V]`.
- Cada sessão recebe settings clonados para o seu cwd (`args.settings.cloneForCwd(cwd)`, `main.ts:547`) `[V]`.
- Listagem: página de 50, cursor numérico, e `flush` do `sessionManager` de cada sessão aberta antes de listar (`acp-agent.ts:897-912`) `[V]`.

## Métodos do agente

| Método | Efeito | Linha |
|---|---|---|
| `initialize` | `agentCapabilities`: `loadSession: true`, MCP http e sse, `promptCapabilities` (embeddedContext, image), `sessionCapabilities` (list, fork, resume, close); `_meta.steering.supported: true` `[V]` | 808-860 |
| `authenticate` | aceita o método `agent`; `terminal` só se anunciado `[S]` | 861-871 |
| `newSession` | devolve `sessionId`, `configOptions`, `modes` e agenda atualizações de bootstrap `[V]` | 873-883 |
| `loadSession` | reexecuta o histórico (`#replaySessionHistory`) `[V]` | 885-895 |
| `listSessions` | paginado, filtro opcional por `cwd` `[V]` | 897-912 |
| `resumeSession` | retoma sem replay `[V]` | 914-923 |
| `unstable_forkSession` | cria sessão nova a partir da atual `[V]` | 925-935 |
| `closeSession` | libera o registro `[V]` | 937-944 |
| `setSessionMode` | aplica modo e emite `current_mode_update` `[V]` | 946-955 |
| `setSessionConfigOption` | só `mode`, `model`, `thinking`; valor booleano é rejeitado; outro `configId` lança erro `[V]` | 957-1001 |
| `prompt` | também trata steering, cancelamento implícito e fila `[V]` | 1003-1117 |
| `cancel` | cancela tudo que a sessão aceitou, inclusive prompts em fila `[V]` | 1324 |
| `extNotification` | corpo vazio; notificações do cliente são ignoradas `[V]` | 1576 |

## Métodos de extensão (`extMethod`)

| Nome | Params | Retorno | Linha |
|---|---|---|---|
| `speech.models.list` | nenhum | catálogo de speech `[V]` | 1418 |
| `_omp/sessions/listAll` | `limit` (padrão 1000, máx 5000) | `sessions`, `total` `[S]` | 1420 |
| `_omp/projects/list` | nenhum | `projects`, `totalSessions` `[S]` | 1429 |
| `_omp/chats/byCwd` | `cwd` obrigatório, `limit` (padrão 100, máx 500) | `sessions` `[S]` | 1457 |
| `_omp/usage` | nenhum | `reports` (inclui `premiumRequests`, `cost`, `subagentCost`) `[S]` | 1465 |
| `_omp/extensions` | `cwd` opcional | `extensions` `[S]` | 1474 |
| `_omp/extensions/toggle` | `providerId`, `enabled` | `enabled` `[S]` | 1481 |
| `_session/steering` | `sessionId`, `prompt` (content blocks), `_meta.steering.queue` | entrega como steer ou follow-up `[V]` | 1491, 1524-1554 |
| qualquer outro | | erro `Unknown ACP ext method` `[V]` | 1493 |

## Config options e modos

- Config options: `mode`, `model` (só se houver modelos), `thinking` (categoria `thought_level`, inclui Off e Auto) (`acp-agent.ts:2136-2174`) `[V]`.
- Modos: `default` sempre; `plan` só quando `cfgPlanEnabled` está ligado nas settings da sessão (`#getAvailableModes`, 2219-2230) `[V]`.
- Ao ligar `plan`, o agente chama `session.setPlanModeState({ enabled: true, planFilePath, workflow })` e registra o handler de proposta `xd://propose` (2241-2255) `[V]`.
- Aprovação do plano usa as opções `"Approve and execute"` e `"Refine plan"` (`acp-agent.ts:104-105`) `[V]`. Cancelamento, timeout ou outra resposta caem em refinar. Cliente sem elicitation de formulário aprova sozinho (~2264-2420) `[S]`.

## Aprovação de tools

- Tools com gate: `bash`, `edit`, `delete`, `move` (`session/acp-permission-gate.ts:7-11`) `[S]`.
- Opções enviadas: `allow_once`, `allow_always`, `reject_once`, `reject_always` (mesmo arquivo, 15-20) `[S]`.
- Decisões `*_always` ficam em cache na sessão, exceto quando a política de bash força prompt (`session/session-tools.ts:981-987`) `[S]`.
- Modos: `always-ask`, `always-ask-cached`, `write`, `yolo` (`cli/flag-tables.ts:241-251`) `[S]`. O default do schema é `yolo`, mas sem opt-in explícito (flag ou config) bash sem match e operações destrutivas de arquivo ainda exigem grant do cliente ACP (`docs/approval-mode.md:193`) `[V]`.
- Não existe campo de approval em `session/new`, `session/load` ou `session/resume`. Approval por sessão exige um processo `omp acp` por política, com `--approval-mode` ou `--config` (`docs/approval-mode.md:191`) `[V]`.
- Steering durante o diálogo cancela o diálogo e aborta a tool (`session-tools.ts:1009-1083`) `[S]`.

## O que o cliente precisa oferecer

- `requestPermission` é sempre usado (`modes/acp/acp-client-bridge.ts:38`) `[S]`.
- `fs.readTextFile`, `fs.writeTextFile` e `terminal` vêm das `clientCapabilities` declaradas no `initialize` `[S]`.
- `elicitation.form` é o que habilita `ask`, `select`, `confirm` e `input` (`acp-agent.ts:622`). Sem ele: `select` e `input` devolvem `undefined`, `confirm` devolve `false`, e o editor não é suportado (`supportsEditor: false`) (`622-770`) `[S]`.

## MCP no ACP

- O ACP desliga a descoberta em disco: `enableMCP: false` em toda sessão (`main.ts:582`), porque os servidores pertencem ao cliente (comentário em `main.ts:538-543`) `[V]`.
- Os servidores chegam por `session/new.mcpServers`. Transportes aceitos: `stdio`, `http`, `sse`; `acp` é rejeitado (`acp-agent.ts:3144-3166`) `[S]`.
- Consequência: `~/.omp/agent/mcp.json` e `.omp/mcp.json` não valem no ACP. O desktop precisa ler esses arquivos e repassar os servidores.
- Falha de conexão não derruba a sessão (`3125-3135`) `[S]`.

## Eventos

O mapper converte poucos eventos. O `default` devolve `[]` (`modes/acp/acp-event-mapper.ts:268-269`) `[V]`.

| Evento do omp | Vira no ACP | Linha |
|---|---|---|
| `message_update` | `agent_message_chunk` ou `agent_thought_chunk` `[S]` | mapper 194, 277-355 |
| `message_end` | `agent_message_chunk` só se nenhum texto saiu `[S]` | 196, 362-383 |
| `tool_execution_start/update/end` | `tool_call` e `tool_call_update` `[S]` | 198-257 |
| `todo_reminder`, `todo_auto_clear` | `plan` `[S]` | 258-267 |
| `model_changed`, `thinking_level_changed` | `config_option_update` (via `acp-agent.ts:1735-1741`) `[S]` | |
| `agent_end` | `usage_update` e `session_info_update` | agent 2575-2598 `[S]` |
| modo | `current_mode_update` `[V]` | agent 2440 |

Descartados `[S]`: `agent_start`, `turn_start`, `turn_end`, `message_start`, `tool_stream_update`, `auto_compaction_*`, `auto_retry_*`, `retry_fallback_*`, `cache_warming_*`, `config_warnings_changed`, `advisor_cost_changed`, `advisor_yielded`, `ttsr_triggered`, `irc_message`, `notice`, `goal_updated`, `queue_update`, e todos os frames de subagent.

`usage_update` sai só no fim do turno, com `size`, `used` e `cost` (USD, só se maior que zero) (`acp-agent.ts:2583-2588`) `[S]`.

## Conteúdo de tool calls `[S]`

- `kind`: `read`→`read`; `write`, `edit`→`edit`; `delete`; `move`; `bash`, `shell`, `exec`, `eval`→`execute`; `grep`, `glob`, `ast_grep`→`search`; `web_search`→`fetch`; `todo`→`think`; o resto, incluindo `task`, vira `other` (`mapper 154-184`).
- `edit` e `write` geram conteúdo `diff` por arquivo; shell gera `$ comando` e `terminal` (`716-785`).
- `locations` resolvidas contra o `cwd` (664, 683).

## Prompt

- Blocos aceitos: `text`, `image`, `resource` (texto ou blob de imagem), `resource_link`. `audio` vira `[audio omitted]` (`acp-agent.ts:2065-2113`) `[S]`.
- `stopReason`: cancelado→`cancelled`; `length`→`max_tokens`; erro com `content_filter` ou `refus*`→`refusal`; resto→`end_turn` (2017-2039) `[S]`.
- Slash builtins com `handle` rodam via `executeAcpBuiltinSlashCommand` (`slash-commands/acp-builtins.ts:59`) `[V]`. Canal exato da saída: não verificado.

## Requisitos que o ACP impõe ao desktop

- Declarar `elicitation.form` no `initialize`, senão `ask` e a aprovação de plano degradam.
- Ler `mcp.json` (usuário e projeto) e repassar `mcpServers` em cada `newSession`, `loadSession` e `resumeSession`.
- Tratar `session/request_permission` com as quatro opções.
- Reiniciar a sessão ou aplicar patch para refletir mudanças de settings (sem watcher no ACP).
- Obter observabilidade de subagents, fila, goal e compaction por patch ou pelo SDK (ver `docs/patches.md`).

## Não verificado

- Canal de saída dos builtins no ACP.
- Linhas exatas de `_omp/*` após 1457 e de `#requestAcpPlanApprovalChoice`.
- Se `--approval-mode` do `omp acp` aceita mudança em runtime (a doc diz que só vale por processo).
- Se existe transporte além de stdio.
