# 0002: Collab fica fora de escopo

Status: aceita (decisão do usuário).

## Contexto

- `collab`, `join` e `leave` dependem do `InteractiveModeContext`: `collab/controller.ts:66`, `collab/host.ts:254`, `collab/guest.ts:280` `[S]`.
- Nenhuma superfície (ACP, SDK, RPC) alcança isso sem refatorar o omp.

## Decisão

- O desktop não implementa collab.
- Docs e issues não tratam collab como lacuna. Quem encontrar a menção nas fontes do omp ignora.

## Consequências

- `/collab`, `/join` e `/leave` não aparecem na paleta de comandos do desktop.
- Reabrir só se o omp desacoplar o collab do `InteractiveModeContext`.
