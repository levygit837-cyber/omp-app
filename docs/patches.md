# Patches propostos no omp

Regra: PR upstream primeiro (`can1357/oh-my-pi`); manter localmente só se demorar. Sem fork permanente (ADR 0001). Checkout de referência: `~/Developer/bigbang-deps/oh-my-pi`, omp 18.12.6, commit `0b5c27ab24`. Reconferir contra o `HEAD` antes de cada patch.

Cada patch só entra se o host em processo (SDK) não resolver sozinho. Antes de abrir um patch, confirmar em `research/05-tui-only-gaps.md` que a classe é PATCH.

| # | Patch | Motivo | Onde mexer | Tamanho |
|---|---|---|---|---|
| P1 | Extrair o estado do loop mode do `InteractiveMode` para um módulo reutilizável | `loopModeEnabled`, `loopPrompt`, `loopLimit`, `pauseLoop` vivem só no TUI; não há `setLoop` no `AgentSession` | `modes/interactive-mode.ts:1330,3253,3302`; já existe `modes/loop-limit.ts` | médio `[S]` |
| P2 | Extrair a orquestração do vibe (`VibeSessionRegistry`) para fora do `InteractiveMode` | só os métodos de baixo nível são públicos | `modes/interactive-mode.ts:~6170` | a medir |
| P3 | Extrair ligar e desligar do goal e do guided-goal | `getGoalModeState` só lê; o RPC tem versão em `modes/rpc/rpc-goal.ts` | `modes/interactive-mode.ts:~6405,~6449` | a medir |
| P4 | ~~Dar `handle` a `clear`, `pause` e `delete`~~ Descartado: os três são classe SDK em `research/05-tui-only-gaps.md:25,26,30`, e o sidecar os chama direto (`resetSessionContext`, `agentPauseGate`, apagar arquivo + `newSession`). Pela regra acima, não justificam patch | — | — | — |
| P5 | Repassar no ACP os eventos hoje descartados | só necessário se o desktop usar o ACP puro, sem host em processo | `modes/acp/acp-event-mapper.ts:268-269` | médio |

## Dependências entre patches

- P4 descartado (ver tabela).
- P1, P2 e P3 só valem a pena se o desktop precisar desses modos antes de o upstream expô-los.
- P5 vira desnecessário se a decisão do ADR 0001 (host Bun em processo) se confirmar no spike.

## Critério de aceite de qualquer patch

- Teste no repo do omp que falha sem o patch.
- `bun run gen:rpc` sem diff, quando tocar o schema do RPC (`test/rpc-wire/generated.test.ts`).
- Nota aqui com o link do PR e o commit local, se mantido.
