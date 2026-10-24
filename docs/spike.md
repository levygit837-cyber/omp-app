# Spike: validar o ADR 0001

Objetivo: provar que um sidecar Bun roda o `AcpAgent` em processo e entrega eventos que o ACP descarta. Código descartável; não vira o app.

## Passos

1. Script Bun que importa `AcpAgent` e `createAcpConnection` do checkout do omp e sobe uma conexão ndJSON em stdio.
2. Fábrica de sessão: tentar `createAcpSessionFactory` de `main.ts`. Se o import disparar startup, montar a factory à mão com `createAgentSession`.
3. A cada sessão criada pela factory, guardar a `AgentSession` e assinar os eventos.
4. Cliente Node mínimo (simulando o Electron): `spawn` do sidecar, `initialize` com `elicitation.form`, `newSession`, `prompt`.
5. Imprimir lado a lado: o que chega como `sessionUpdate` e o que chega só pela assinatura direta.
6. Chamar `agentPauseGate.pause()` e `session.resetSessionContext()` e observar o efeito.

## Perguntas a fechar

- O import de `main.ts` tem efeitos colaterais?
- Duas sessões no mesmo `AcpAgent` interferem (MCP, settings, `AgentRegistry`)?
- Eventos de subagent, `queue_update` e compaction chegam pela assinatura direta?
- `mcpServers` de `mcp.json` entram pelo `newSession`?
- O `pause` global afeta todas as sessões do processo?

## Aceite

- Cada pergunta respondida com saída observada, registrada em `docs/adr/0001` (atualizando o status) ou em nova ADR.
- Se duas sessões interferirem, o ADR passa a prever um sidecar por aba.

## Resultados (2026-10-24, omp 18.12.6, modelo `kiro/claude-haiku-5.5`)

Código em `spike/` (descartável): `sidecar.ts` (Bun), `client.mjs` (Node, faz o papel do Electron), `echo-mcp.mjs`. Rodar: `cd spike && node client.mjs [cenario...]`. Cenários: `basic`, `isolation`, `clear`, `steering`, `subagent`, `mcp`, `ask`, `plan`.

| Pergunta | Resposta observada |
|---|---|
| Rodar o `AcpAgent` em processo funciona? | Sim. `initialize`, `session/new` e `session/prompt` fecharam com `end_turn` |
| Eventos que o ACP descarta chegam pela assinatura direta? | Sim. Num turno simples o ACP entregou 4 tipos de update (`available_commands_update`, `session_info_update`, `agent_message_chunk`, `usage_update`). A assinatura direta entregou `agent_start`, `turn_start`, `message_start/update/end`, `turn_end`, `agent_end` |
| `queue_update` | Só pela assinatura direta: 2 eventos, com a mensagem entrando e saindo da fila. ACP: 0 |
| Frames de subagent | Só pelo `subagentEventBus` (`task:subagent:event`). ACP: 0 updates com subagent |
| `_session/steering` com `_meta.steering.queue: "followUp"` | Respondeu `outcome: "injected"` e o turno terminou `end_turn` |
| `pause` afeta uma ou todas as sessões? | Todas. Duas sessões em paralelo ficaram congeladas por 8 s (1 tool call cada, sem avanço). Após `resume`, as duas chegaram a 6 tool calls e `end_turn`. Por isso `pause` (o `/pause` do TUI) NÃO é o ESC |
| `session/cancel` (equivalente do ESC) | Só a sessão alvo parou. A recebeu `stopReason: "cancelled"` e ficou em 1 tool call. B, no mesmo processo, seguiu até 6 tool calls e `end_turn`. `paused` ficou `false` |
| `session/cancel` com subagente em andamento | O prompt voltou `cancelled` em 3 ms, mas o subagente NÃO parou: o `sleep 12` dele terminou 12012 ms depois do cancel (`tool_execution_end`) e o `agent_end` do subagente veio aos 14819 ms. Causa não determinada: pode ser job em background que `abort()` não cancela, ou o sinal não chegar ao subagente. Não comparei com o ESC no TUI real |
| `resetSessionContext()` pelo sidecar | Funciona: 14 mensagens viraram 0 |
| `mcpServers` em `session/new`, duas sessões com servidores diferentes no mesmo processo | Cada sessão registrou só a sua tool (`mcp__spike_echo_a_spike_echo` e `mcp__spike_echo_b_spike_echo`). Rodando as duas em paralelo, A recebeu só `ECO-A: ola` e B só `ECO-B: ola`. O singleton `MCPManager` não misturou as sessões |
| `ask` pelo ACP | Chega como `elicitation/create` em modo `form`, com `oneOf` (Azul, Verde, Vermelho) e um campo `q0__other`. O cliente respondeu `q0: "Vermelho"`, e o agente repetiu "Vermelho." Exige `ensureTheme()` no host: sem ele a tool `ask` falha com `theme.status` indefinido (o `omp acp` real chama `ensureTheme` em `main.ts:1789`) |
| Modo `plan` por `session/set_mode` | `getPlanModeState()` foi de `null` para `{ enabled: true, planFilePath: "local://PLAN.md", workflow: "parallel" }` e voltou a `null` em `default` |
| Permissões: aceitar | O cliente respondeu `session/request_permission` com `allow_once` e o `bash` rodou |
| Permissões: recusar | Com `reject_once`, o `touch` não criou o arquivo (`fileCreated: false`), o agente recebeu a recusa e o turno terminou `end_turn` |
| Aprovação de plano | Com o modo `plan`, o agente propôs o plano e o cliente recebeu duas vezes `elicitation/create` ("Approve plan ... and start implementation?"). Respondendo `Refine plan`, o plan mode seguiu ativo; respondendo `Approve and execute`, `getPlanModeState()` voltou a `null` e o agente passou a executar (pediu permissão de `bash`) |
| Gravar API key | `authStorage.credentials.set(provider, { type: "api_key", key })` persiste num `agent.db` do `agentDir`. Testado num diretório temporário, sem tocar nas credenciais reais: `has` passou de falso a verdadeiro, `keys.get` devolveu a chave, uma segunda instância no mesmo diretório a enxergou, `list` não expõe o segredo e `remove` apagou. O desktop não precisa do login do RPC para isso |

## O que o spike não cobriu

- Importar `main.ts` foi testado só no import (493 ms, sem crash, 2 listeners de processo a mais em `exit`/`SIGINT`). A factory foi montada à mão e não usa `createAcpSessionFactory`.
- Login OAuth (`authStorage.oauth.login`): só a gravação de API key foi testada.
- Empacotar o Bun dentro do Electron.

## Preparação do checkout (necessária para repetir)

- `bun install --frozen-lockfile` na raiz do checkout do omp (cria `node_modules`, ignorado pelo git).
- Link do addon nativo, porque o loader só procura em `packages/natives/native/`: `ln -s ~/.omp/natives/18.12.6/pi_natives.darwin-arm64.node packages/natives/native/` (o git também ignora `*.node`). Trocar a versão no caminho ao atualizar o omp.
