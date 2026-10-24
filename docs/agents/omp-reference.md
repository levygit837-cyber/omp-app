# Como consultar o SDK e o sidecar do omp

Para agentes que precisam avaliar o que o omp oferece antes de planejar uma tarefa. Não confie só nos docs de pesquisa deste repo: eles têm marcas `[S]`/`[I]` e números de linha de um commit específico. Confira no código.

## Fontes, da mais estável à mais volátil

| Fonte | Onde | Quando usar |
|---|---|---|
| Docs oficiais do omp | `~/Developer/bigbang-deps/oh-my-pi/docs/*.md` (ou `read omp://<arquivo>.md`) | Comportamento descrito pelo autor: `sdk.md`, `rpc.md`, `session.md`, `settings.md`, `approval-mode.md`, `mcp-runtime-lifecycle.md`, `extensions.md`, `slash-command-internals.md` |
| Código do omp | `~/Developer/bigbang-deps/oh-my-pi/packages/` | Fonte da verdade. Os docs podem estar atrasados |
| Docs de pesquisa daqui | `docs/research/` | Atalho já filtrado para o desktop. Tratar `[S]` e `[I]` como pista |
| Sidecar do spike | `spike/sidecar.ts` e `docs/sidecar.md` | Contrato real entre Electron e omp, já exercitado |
| Resultados medidos | `docs/spike.md` | O que foi observado rodando, com versão e modelo |

Checkout de referência: omp 18.12.6, commit `0b5c27ab24`. Se `git -C ~/Developer/bigbang-deps/oh-my-pi log -1 --format=%h` mostrar outro commit, reconfira as linhas citadas.

## Onde está cada coisa no código do omp

Caminhos relativos a `packages/`.

| Tema | Arquivo | Símbolo |
|---|---|---|
| Criar uma sessão | `coding-agent/src/sdk.ts` | `createAgentSession` (1758), `CreateAgentSessionOptions` (546), `CreateAgentSessionResult` (951), `discoverAuthStorage` (1045) |
| A sessão | `coding-agent/src/session/agent-session.ts` | classe `AgentSession`; `subscribe` (5539), `isStreaming` (6524), `abort` (10606) |
| Eventos da sessão | `coding-agent/src/session/agent-session-events.ts` | `AgentSessionEvent` (14) |
| Eventos do agent loop | `agent/src/types.ts` | `AgentEvent` (1264) |
| Pausa global | `agent/src/pause.ts` | `agentPauseGate` (107) |
| ACP: agente e métodos | `coding-agent/src/modes/acp/acp-agent.ts` | `cancel` (1324), `extMethod` com `_omp/*` (1416-1491), `_session/steering` |
| ACP: conexão e factory | `coding-agent/src/modes/acp/acp-mode.ts` | `createAcpConnection`, `AcpSessionFactory` |
| Slash commands | `coding-agent/src/slash-commands/` | builtins com `handle` e `handleTui`; filtro do ACP em `acp-builtins.ts` |
| Jobs em background | `coding-agent/src/async/job-manager.ts` | `AsyncJobManager.cancelAll` (649) |
| Settings | `coding-agent/src/config/settings.ts` | `Settings` |
| MCP | `coding-agent/src/mcp/` | `manager.ts`, `config-writer.ts` |

Linhas mudam a cada release. Para achar um símbolo de novo, use `grep` no símbolo em vez de confiar no número.

## Receitas

Listar a superfície pública da `AgentSession` (aproximadamente 346 membros; a contagem vem de regex, não de parser):

```sh
grep -nE "^	(async |get |set )?[a-z][A-Za-z0-9]*\(" \
  ~/Developer/bigbang-deps/oh-my-pi/packages/coding-agent/src/session/agent-session.ts
```

Membros com `#` são privados e não aparecem nessa regex. Não cite um método sem ler a assinatura.

Ver o que o ACP aceita e o que ele descarta:

- Métodos de entrada: ler `acp-agent.ts` a partir de `async cancel`, `extMethod` e `prompt`.
- Eventos de saída: `modes/acp/acp-event-mapper.ts` (o que vira `sessionUpdate`). O que não passa por ali só chega por `subscribe` ou `subagentEventBus`. Detalhe em `docs/research/02-acp.md`.

Ver quais builtins rodam fora do TUI: `docs/research/05-tui-only-gaps.md` traz a lista. Para reconferir, um builtin com `handle` roda em ACP/RPC; só com `handleTui` não roda.

Ver os tipos de uma opção: ler a interface em `sdk.ts:546` e seguir os tipos importados. Não há tipos publicados; o `package.json` do `coding-agent` exporta `.ts` cru (`"./*": "./src/*.ts"`).

## Como validar uma hipótese rodando

1. Prepare o checkout uma vez (`docs/spike.md`, "Preparação do checkout").
2. Acrescente um cenário em `spike/client.mjs` (objeto `scenarios`, ver `cancel` e `cancelSubagent` como modelo).
3. Se precisar de um dado novo da sessão, acrescente um `case` em `handleCommand` de `spike/sidecar.ts`.
4. `cd spike && node client.mjs <cenario>`.
5. Registre o resultado em `docs/spike.md` com versão do omp e modelo. Remova `sidecar.stderr.log` e `results.json` depois.

Use o modelo `kiro/claude-haiku-5.5` nos testes (mais barato). Nunca grave credenciais reais: o teste de API key usou um `agentDir` temporário.

## Armadilhas já conhecidas

- `stdout` do sidecar é do ACP. Qualquer `console.log` corrompe o protocolo.
- `agentPauseGate` é global ao processo; `session/cancel` é por sessão. Não confundir `/pause` com ESC.
- `session/cancel` não derrubou um subagente em andamento (ver `adr/0001`).
- O ACP não traz `queue_update` nem frames de subagent. Só a assinatura direta traz.
- `enableMCP: false` na factory: MCP do disco é ignorado; vale `session/new.mcpServers`.
- Sem `ensureTheme()` a tool `ask` falha.
- O ACP não observa mudanças em `config.yml`; chamar `reloadFromDisk()` após escrever.
