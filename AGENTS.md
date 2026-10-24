# omp-app: agent guide

Desktop app (Electron) for omp. Current phase: documentation and a validated spike (`spike/`, disposable); the app itself does not exist yet. Vocabulary in `CONTEXT.md`; decisions in `docs/adr/`.

## Where to look

- `docs/README.md`: docs index. `CONTEXT.md` has the "where to find what" index.
- `docs/sidecar.md` and `docs/agents/omp-reference.md`: sidecar contract and how to consult the omp SDK. Read before planning any task that touches omp.
- `docs/research/`: what each omp surface delivers and what is missing. Start with `01-surfaces.md`.
- `docs/architecture.md`, `docs/patches.md`, `docs/spike.md`: design, patches to omp, and validation plan.
- omp code to check against: `~/Developer/bigbang-deps/oh-my-pi/packages/coding-agent/src` (reference checkout at commit `0b5c27ab24`).

## Rules

- Scope: SDK + ACP + patches. Collab is out (ADR 0002).
- No permanent omp fork. A patch goes upstream as a PR first (`docs/patches.md`).
- A claim about omp without reading code gets `[S]` or `[I]`; only direct reading gets `[V]`.
- Cite `file:line`. When bumping the checkout version, recheck the cited lines.
- Do not edit the omp checkout unless asked. Patches start in their own worktree/branch.

## Language

- English: issues, PRs, branch names, commit messages, `AGENTS.md`, `CONTEXT.md`, code, and identifiers.
- pt-BR: everything under `docs/`, which is local-only (not pushed to GitHub). Technical terms and identifiers stay in English.

## Agent skills

### Issue tracker

Issues live on GitHub (`levygit837-cyber/omp-app`), via `gh`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary for the five roles. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` and `docs/adr/` at the root. See `docs/agents/domain.md`.

## Toolchain pins

- TypeScript is pinned to `6.0.3`, not 7. dependency-cruiser 18.7.0 supports only TypeScript below 7 and silently skips TS sources on 7.x. Revisit when dependency-cruiser supports 7.
- Root `trustedDependencies` lists only `electron`. Electron 45 has no `postinstall`: its binary downloads lazily on the first `electron` or `electron-vite` run, not during `bun install`. `esbuild` is not trusted because nothing here needs its install script.
- The sandboxed preload is built as CommonJS (`out/preload/index.cjs`) because `sandbox: true` cannot load ESM preloads.
