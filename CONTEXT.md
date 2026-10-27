# omp-app: context

Own desktop app for omp (oh-my-pi), covering the functions a real user relies on. Decisions live in `docs/adr/`.

The `docs/` folder is local-only and written in pt-BR. Glossary terms below carry the pt-BR term used there in parentheses.

## Glossary

- **omp**: the coding agent `can1357/oh-my-pi`. This project does not replace it; it hosts and drives it.
- **Surface** (superfície): a way to integrate with omp. The four: ACP, SDK, RPC, json. Matrix in `docs/research/01-surfaces.md`.
- **ACP**: Agent Client Protocol over stdio (`omp acp`). Chosen, together with the SDK.
- **SDK**: `createAgentSession` from the `@oh-my-pi/pi-coding-agent` package. Requires Bun.
- **RPC**: `omp --mode rpc`. Code reference only; not the chosen surface.
- **Sidecar**: Bun process that hosts omp for Electron.
- **Session** (sessão): one `AgentSession`, one conversation. One app **tab** (aba) shows one session.
- **Builtin**: omp internal slash command. **`handle`** runs outside the TUI; **`handleTui`** runs only in the TUI.
- **TUI-only**: builtin without `handle`. 40 of 86.
- **Gap** (lacuna): a function no surface delivers. Becomes own UI, SDK usage, or a patch. See `docs/research/05-tui-only-gaps.md`.
- **Patch**: small change to omp, upstream PR first. See `docs/patches.md`.
- **Reference checkout** (checkout de referência): `~/Developer/bigbang-deps/oh-my-pi`, omp 18.12.6, commit `0b5c27ab24`. Line numbers in the docs come from it.
- **Collab**: omp shared session. Out of scope (ADR 0002). Do not treat as a gap.

## Confidence marks in research docs

- `[V]` verified in omp code or docs.
- `[S]` reported by a subagent, not checked. Treat as a lead.
- `[I]` inference.

## Index: where to find what

- **Sidecar contract** (channels, commands, events, factory, environment variables): `docs/sidecar.md`.
- **How an agent consults the SDK and omp code** (sources, file map, recipes, pitfalls): `docs/agents/omp-reference.md`.
- **Official omp docs**: `~/Developer/bigbang-deps/oh-my-pi/docs/` (or `read omp://sdk.md`). Start with `sdk.md`, `rpc.md`, `session.md`, `settings.md`.
- **omp code**: `~/Developer/bigbang-deps/oh-my-pi/packages/`. SDK entry: `coding-agent/src/sdk.ts`; session: `coding-agent/src/session/agent-session.ts`.
- **Research per surface** (ACP, SDK, RPC, gaps, management): `docs/research/`, starting with `01-surfaces.md`.
- **What was measured by running**: `docs/spike.md`. Test sidecar code: `spike/`.
- **Decisions**: `docs/adr/`. Patches proposed to omp: `docs/patches.md`.
- **Visual design**: `design/omp.pen` (exploration, edited live in Pen) and `design/preview/` (exported screens). The tokens live in `packages/ui/src/tokens.css`, with the same names as the Pen variables. Code wins if they diverge.
- **Full docs index**: `docs/README.md`.
