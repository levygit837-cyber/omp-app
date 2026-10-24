import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadAllMCPConfigs } from "@oh-my-pi/pi-coding-agent/mcp/config";
import { cfgMcpEnableProjectConfig } from "@oh-my-pi/pi-coding-agent/mcp/settings";
import type { MCPServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import type { McpServer } from "@oh-my-pi/pi-utils/acp";

const toPairs = (values: Readonly<Record<string, string>> | undefined) =>
  Object.entries(values ?? {}).map(([name, value]) => ({ name, value }));

/**
 * Converts omp's resolved server configs to the shape `session/new` carries. ACP has no field
 * for `cwd`, `timeout`, `auth` or `oauth`, so those do not travel; everything that decides
 * whether the server starts (command, args, env, url, headers, transport) does.
 */
export function toAcpServers(configs: Readonly<Record<string, MCPServerConfig>>): McpServer[] {
  return Object.entries(configs).map(([name, config]): McpServer => {
    if (config.type === "http" || config.type === "sse") {
      return { type: config.type, name, url: config.url, headers: toPairs(config.headers) };
    }
    return {
      type: "stdio",
      name,
      command: config.command,
      args: config.args ?? [],
      env: toPairs(config.env),
    };
  });
}

/**
 * The servers the CLI would load for `cwd`, by omp's own resolver (`loadAllMCPConfigs`): user
 * `<agentDir>/mcp.json`, project `<cwd>/.omp/mcp.json` and the other sources omp discovers,
 * with omp's precedence, `disabled`/`enabled` handling and env expansion. Read-only.
 *
 * `settings` must be the session's settings (cloned for `cwd`): `mcp.enableProjectConfig`
 * is read from them exactly as the CLI does. Exa servers are filtered like the CLI does.
 */
export async function resolveMcpServers(cwd: string, settings: Settings): Promise<McpServer[]> {
  const { configs } = await loadAllMCPConfigs(cwd, {
    enableProjectConfig: cfgMcpEnableProjectConfig.get(settings),
    filterExa: true,
  });
  return toAcpServers(configs);
}

const FAILURE =
  /^MCP server "(.+)" failed to connect: ([\s\S]*)\. Its tools are unavailable [\s\S]*\.$/;

/**
 * Reads omp's connection-failure notice (an `agent_message_chunk` it sends right after
 * `session/new`) back into server and reason. omp offers no structured channel for this; the
 * text is pinned to the installed omp by a test. Returns null for any other text.
 */
export function parseMcpFailure(text: string): { server: string; message: string } | null {
  const match = FAILURE.exec(text);
  return match?.[1] && match[2] !== undefined ? { server: match[1], message: match[2] } : null;
}
