# RPC: referência para patches

O RPC não é a superfície escolhida (ADR 0001). Este doc existe porque o RPC já implementa, fora do TUI, comportamentos que os patches vão copiar. Spec completa: `docs/rpc.md` no checkout (também `omp://rpc.md`). Não duplicar a spec aqui.

Fonte e legenda: ver `01-surfaces.md`.

## Onde está o contrato

- Schema gerado: `modes/rpc/wire/rpc-wire.schema.json`, com 67 comandos em `x-rpc.commands` `[V]`. Regenerar com `bun run gen:rpc`.
- Tipos TypeScript: `modes/rpc/wire/rpc-wire.generated.ts` `[V]`. Clientes Python, Rust e Go são gerados do mesmo schema `[V]`.
- Um teste do repo falha quando o schema fica desatualizado (`packages/coding-agent/test/rpc-wire/generated.test.ts`) `[V]`.

## O que já existe no RPC e falta no ACP

| Capacidade | Onde copiar |
|---|---|
| Goal com continuação automática | `modes/rpc/rpc-goal.ts` `[V]` |
| Subagents: listar, ler transcrição, steer, cancelar, eventos | `modes/rpc/rpc-subagents.ts`, `rpc-mode.ts:2255` `[S]` |
| Fila: remover e promover item, restaurar ao abortar | comandos `remove_queued_message`, `promote_queued_message`, `abort_and_restore_queue` `[V]` |
| Filtro de eventos com `messageUpdates: "delta"` | `set_event_filter` `[V]` |
| `/btw` com histórico | comandos `btw`, `btw_cancel`, `get_btw_history` `[V]` |
| Voz ao vivo | `live_start`, `live_stop`, `live_mute` `[V]` |
| Árvore e entradas da sessão | `get_tree`, `get_entries` `[V]` |
| Logout por credencial | `get_logout_accounts`, `logout` `[V]` |
| Eventos de compaction, retry, notice, queue | repassados como `AgentSessionEvent` `[V]` |

## Como o RPC roda builtins

- `rpc-mode.ts` chama `executeAcpBuiltinSlashCommand` quando o texto do `prompt` começa com `/` (`rpc-mode.ts:1811`) `[V]`. Os builtins com `handle` rodam; os TUI-only passam adiante como texto de prompt.
- A saída dos builtins sai em frames `command_output`, `session_info_update` e `config_update` (`rpc-mode.ts:999-1006`) `[V]`.

## Limites documentados do RPC

- Sem UI de terminal: component factories, editors custom, troca de tema, expansão de tool.
- Sem handler de UI para autenticação de MCP.
- Login com input secreto é rejeitado.
- Título automático de sessão desligado (`PI_NO_TITLE=1`); `rpc-ui` define `PI_NO_PTY=1`.
- Defaults neutros fixados para async-jobs, memory e advisor quando a config não define o valor.
