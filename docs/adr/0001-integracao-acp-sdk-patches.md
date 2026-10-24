# 0001: Integrar com o omp por ACP + SDK + patches

Status: aceita com ressalvas. Spike de 2026-10-24 confirmou o desenho (`docs/spike.md`, seção Resultados). Seguem abertas as ressalvas listadas abaixo.

## Contexto

- O desktop precisa cobrir tudo que um usuário faz no omp. Matriz em `research/01-surfaces.md`.
- O ACP cobre sessão, plan mode, aprovação, steering e MCP, mas descarta subagents, fila, goal e compaction (`research/02-acp.md`).
- O SDK alcança o estado interno do `AgentSession`, mas exige Bun e compartilha estado global entre sessões do mesmo processo (`research/04-sdk.md`).
- A Extension API não liga plan, vibe, loop nem pause (`research/01-surfaces.md`).
- O usuário decidiu: SDK + ACP + patches, sem fork permanente, collab fora (ADR 0002).

## Decisão

- Um **sidecar Bun** hospeda o omp. Electron (Node) fala com o sidecar por IPC.
- O sidecar roda o `AcpAgent` em processo e guarda as `AgentSession` que a factory cria. `AcpAgent` e `AcpSessionFactory` são exportados (`modes/acp/acp-agent.ts:787`, `modes/acp/acp-mode.ts:10-24`) `[V]`.
- Da mesma sessão, o sidecar assina todos os `AgentSessionEvent` e chama métodos públicos do `AgentSession` para o que o ACP não entrega (pause, clear, vibe, plan).
- O que nem o SDK alcança vira patch pequeno no omp (`docs/patches.md`), com PR upstream primeiro.
- Gestão (settings, MCP, skills, plugins) usa CLI com `--json` e APIs importáveis (`research/06-management.md`).

## Por que não as alternativas

- **Só ACP**: perde observabilidade (`02-acp.md`, eventos descartados) e comandos de `05-tui-only-gaps.md`.
- **Só RPC**: tem a observabilidade, mas o mesmo buraco nos comandos TUI-only, e o desktop não alcança o estado interno.
- **Extension como ponte**: não expõe os modos. Descartada.
- **Fork**: custo permanente de merge. Só como último recurso.

## Riscos a validar no spike

- Importar `createAcpSessionFactory` de `main.ts` pode disparar efeitos colaterais de startup `[I]`.
- Várias sessões no mesmo `AcpAgent` compartilham estado global do processo (`MCPManager` é singleton, `mcp/manager.ts:247`) `[V]`. Se isso quebrar o isolamento, passar a um processo sidecar por aba.
- O pacote exporta `.ts` cru; o sidecar precisa de Bun >= 1.3.14 (`package.json:573`) `[V]`.
- Cada atualização do omp pode mover linhas citadas nos docs. Reconferir a versão.

## Consequências

- O app embarca ou localiza um Bun. ~~A forma de distribuição fica aberta.~~ Resolvido no ADR 0003: sidecar compilado com `bun build --compile` e embutido no app.
- O desktop acompanha a versão do omp: o sidecar importa código-fonte, não uma API estável.

## Resultado do spike

- Confirmado: o `AcpAgent` roda dentro de um sidecar Bun e as `AgentSession` ficam acessíveis.
- Confirmado: `queue_update` e os frames de subagent chegam pela assinatura direta e não pelo ACP.
- Confirmado: `resetSessionContext()` e o modo `plan` funcionam pelo sidecar.
- Confirmado: `session/cancel` (o ESC do TUI) para só a sessão alvo; outra sessão no mesmo processo segue até o fim. É o "parar" por aba.
- Confirmado: `agentPauseGate` (o `/pause` do TUI) é global ao processo. Não é o ESC: congela os loops sem abortar nada e retoma de onde parou. Não usar como botão por aba.
- Confirmado: `mcpServers` de `session/new` registram a tool, e duas sessões com servidores diferentes no mesmo processo não se misturam (A viu só `ECO-A`, B só `ECO-B`).
- Confirmado: `ask` chega ao cliente como `elicitation/create` e a resposta volta ao agente.
- Requisito do host: chamar `ensureTheme()` de `@oh-my-pi/pi-tui/theme` no startup. Sem isso a tool `ask` quebra.
- Ressalva: `/pause` é um recurso à parte do ESC. Se o app o oferecer, ele vale para o processo inteiro. Por aba exigiria um sidecar por aba ou um patch no omp (gate por sessão).
- Decisão do usuário (2026-10-24): "parar" (ESC) vale só para a sessão da aba. Jobs em background e subagents que já estavam rodando podem terminar sozinhos (no spike, `session/cancel` não derrubou um subagente com `sleep 12`; ele acabou ~12 s depois). Matar um job fica como ação explícita na UI, via `AsyncJobManager.cancelAll({ ownerId })` ou `cancelSubagent` no sidecar. A causa exata de `abort()` não cancelar o job não foi investigada.
- Ressalva: a factory foi montada à mão com `createAgentSession`, sem usar `createAcpSessionFactory` de `main.ts`. Usar a de `main.ts` não foi testado.
- Confirmado: recusar uma permissão (`reject_once`) impede o `bash` de rodar.
- Confirmado: a aprovação de plano funciona por `elicitation/create`. `Refine plan` mantém o plan mode e `Approve and execute` o encerra.
