# Gestão: settings, MCP, skills, plugins, modelos

Fonte e legenda: ver `01-surfaces.md`. Caminhos relativos a `packages/coding-agent/src`.

## Subcomandos CLI com `--json`

| Comando | Cobre | Evidência |
|---|---|---|
| `omp config` | list, get, set, reset, path, init-xdg `[V]` | `commands/config.ts:31-32` |
| `omp models` | listar, buscar, atualizar modelos `[S]` | `commands/models.ts` |
| `omp plugin` (alias `plugins`) | install, uninstall, list, link, doctor, features, config, enable, disable, marketplace, upgrade `[S]` | `commands/plugin.ts`, `cli/plugin-cli.ts` |
| `omp skill` (alias `skills`) | install, search, publish, token, list, info `[S]` | `commands/skill.ts` |
| `omp agents`, `stats`, `usage`, `setup --check` | `[S]` | `commands/*.ts` |

`--json` sem evidência em `update` e `auth` `[S]`. Subcomandos registrados: `cli-commands.ts:28-320` `[V]`.

Não existe `omp mcp` `[V]`: a lista de subcomandos não tem a entrada (grep em `cli-commands.ts`).

## Settings

- Registro por domínio: cada módulo chama `register({...})`; o registro central é `config/registry.ts` e a lista de domínios é `config/all-settings.ts` `[S]`.
- Metadados de UI por setting (`ui.tab`, `group`, `label`, `description`, `condition`, `secret`), tipos `boolean`, `string`, `number`, `enum`, `array`, `record` `[S]`. O desktop pode gerar o formulário a partir disso.
- Global: `config.yml` no diretório do agente (`~/.omp/agent`) `[S]`. Projeto: `<projeto>/.omp/config.yml` `[S]`.
- Contagem exata de settings: não verificada.
- Watcher: `fs.watch` por diretório com debounce de 200 ms e recarga que preserva o último estado válido `[S]`. Só liga em `rpc`, `rpc-ui` e interativo (`main.ts:2654-2659`) `[V]`. Num host ACP ou SDK, chamar `settings.startWatching()` ou `reloadFromDisk()` `[V]`. `startWatching` só age na instância global `[V]`.

## MCP

- Sem CLI. Arquivos: `~/.omp/agent/mcp.json` (usuário), `.omp/mcp.json` (projeto) `[S]`, formato em `docs/mcp-config.md`.
- Escrita: `mcp/config-writer.ts` exporta `readMCPConfigFile`, `writeMCPConfigFile`, `validateServerName`, `addMCPServer`, `updateMCPServer`, `removeMCPServer`, `getMCPServer`, `listMCPServers`, `setServerDisabled`, `setServerForceEnabled`, `setMcpServerEnabled` `[V]`. Escritas passam por `withConfigLock` `[V]`.
- Importável pelo wildcard de `package.json` (`./mcp/*`) `[V]`.
- No ACP o disco é ignorado (`enableMCP: false`, `main.ts:582`), então o desktop lê esses arquivos e entrega os servidores em `session/new.mcpServers` `[V]`.
- Teste de conexão: só `/mcp test` no TUI `[S]`. Sem API equivalente encontrada.
- Watcher de `mcp.json`: não encontrado.

## Skills e plugins

- Skills: listar por `omp skill list --json`; habilitar e desabilitar por settings `skills.enable*`, `skills.ignoredSkills`, `skills.customDirectories` `[S]`. API: `loadSkills` em `extensibility/skills.ts:289` `[S]`.
- Plugins: `PluginManager` em `extensibility/plugins/manager.ts:148` `[S]`; CLI cobre enable e disable.
- Extensões no ACP: ext `_omp/extensions` e `_omp/extensions/toggle` `[S]`.

## Dados para telas de uso

- `_omp/usage` (ACP) e `omp usage --json` para limites por provedor `[S]`.
- `omp stats --json` para estatísticas `[S]`.
- Custo do turno: `usage_update` no `agent_end` (ACP) `[S]`.

## Não verificado

- Contagem de settings; `login`, `token`, `ssh`, `session` nas flags.
- `cli/skill-cli.ts` e `cli/config-cli.ts` além do cabeçalho.
- Gravar API key pelo desktop (o login do RPC rejeita input secreto; o ACP não foi checado).
