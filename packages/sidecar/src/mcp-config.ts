import { join, resolve } from "node:path";
import { invalidate } from "@oh-my-pi/pi-coding-agent/capability/fs";
import type { EffectiveExtensionRoots } from "@oh-my-pi/pi-coding-agent/capability/types";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgEvalJs, cfgEvalPy } from "@oh-my-pi/pi-coding-agent/eval/settings";
import { cfgExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/settings";
import {
  loadAllMCPConfigs,
  shouldFilterBrowserMCPForPrelude,
} from "@oh-my-pi/pi-coding-agent/mcp/config";
import { cfgMcpEnableProjectConfig } from "@oh-my-pi/pi-coding-agent/mcp/settings";
import type { MCPServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { cfgBrowserEnabled } from "@oh-my-pi/pi-coding-agent/tools/browser/settings";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import type { McpServer } from "@oh-my-pi/pi-utils/acp";

const toPairs = (values: Readonly<Record<string, string>> | undefined) =>
  Object.entries(values ?? {}).map(([name, value]) => ({ name, value }));

/**
 * Converts omp's resolved server configs to the shape `session/new` carries.
 *
 * ACP has no field for `timeout`, `auth` or `oauth`, so those do not travel. The working
 * directory does not either, and omp's ACP path spawns stdio servers in the sidecar's own
 * `process.cwd()`, while the CLI uses `config.cwd ?? <project dir>`. To start in the same
 * directory the CLI would, a stdio server is launched through `/bin/sh`, which changes into
 * that directory (`config.cwd` resolved against the session's `cwd`, else the session's `cwd`)
 * and `exec`s the real command. The directory and the command travel as positional arguments,
 * never spliced into the script, so no quoting is involved. POSIX only, which is every
 * platform the app ships on.
 */
export function toAcpServers(
  configs: Readonly<Record<string, MCPServerConfig>>,
  sessionCwd: string,
): McpServer[] {
  return Object.entries(configs).map(([name, config]): McpServer => {
    if (config.type === "http" || config.type === "sse") {
      return { type: config.type, name, url: config.url, headers: toPairs(config.headers) };
    }
    return {
      type: "stdio",
      name,
      command: "/bin/sh",
      args: [
        "-c",
        'cd "$0" && exec "$@"',
        resolve(sessionCwd, config.cwd ?? "."),
        config.command,
        ...(config.args ?? []),
      ],
      env: toPairs(config.env),
    };
  });
}

/**
 * Whether the CLI would hide browser-automation MCP servers for a session with these settings
 * (`initialBrowserPreludeAvailable`, `sdk.ts`). The CLI asks whether the `eval` tool is
 * registered and active; the sidecar runs the default tool set without a restriction list,
 * where `eval` is available when `eval.js` or `eval.py` is on. Not mirrored: the Python
 * availability probe omp runs when `eval.js` is off, so with `eval.js` off and no Python
 * interpreter the CLI keeps browser servers and this hides them.
 */
function browserPreludeAvailable(settings: Settings): boolean {
  return shouldFilterBrowserMCPForPrelude({
    restrictToolNames: false,
    browserEnabled: cfgBrowserEnabled.get(settings),
    evalRegistered: cfgEvalJs.get(settings) || cfgEvalPy.get(settings),
    evalActive: true,
  });
}

/** Extension roots as the sidecar's session factory configures them: no explicit paths, merge. */
function extensionRoots(settings: Settings): EffectiveExtensionRoots {
  return {
    explicit: [],
    mode: "merge",
    configured: cfgExtensions.get(settings),
    configuredLevel: settings.extensionsSourceLevel(),
  };
}

/**
 * Every file omp reads MCP servers from through its process-wide content cache
 * (`capability/fs.ts`): the user and project `mcp.json`, the dot-file variants and the
 * standalone files in the project root (`discovery/builtin.ts:~232-255`, `discovery/mcp-json.ts:171`
 * [V]).
 */
function mcpSourceFiles(cwd: string): string[] {
  const agent = getAgentDir();
  return [
    join(agent, "mcp.json"),
    join(agent, ".mcp.json"),
    join(cwd, ".omp", "mcp.json"),
    join(cwd, ".omp", ".mcp.json"),
    join(cwd, "mcp.json"),
    join(cwd, ".mcp.json"),
    join(cwd, ".claude", "mcp.json"),
  ];
}

/**
 * The servers the CLI would load for `cwd`, by omp's own resolver (`loadAllMCPConfigs`), called
 * with the options `createAgentSession` passes it (`sdk.ts`): user `<agentDir>/mcp.json`,
 * project `<cwd>/.omp/mcp.json` and the other sources omp discovers, with omp's precedence,
 * `disabled`/`enabled` handling and env expansion. Read-only.
 *
 * `settings` must be the session's settings (cloned for `cwd`). Exa servers are filtered out
 * like the CLI does, and their API keys are dropped on purpose: the app has no native Exa
 * integration yet, so nothing would consume them.
 *
 * omp reads these files through a cache that only its own writers invalidate. A person who
 * fixes an `mcp.json` by hand (the app tells them to) writes behind that cache, so a session
 * would start on the old content. The cache is dropped for these files first, so a new session
 * always starts from what is on disk.
 */
export async function resolveMcpServers(cwd: string, settings: Settings): Promise<McpServer[]> {
  for (const file of mcpSourceFiles(cwd)) invalidate(file);
  const { configs } = await loadAllMCPConfigs(cwd, {
    enableProjectConfig: cfgMcpEnableProjectConfig.get(settings),
    filterExa: true,
    filterBrowser: browserPreludeAvailable(settings),
    extensionRoots: extensionRoots(settings),
  });
  return toAcpServers(configs, cwd);
}

const FAILURE =
  /^MCP server "(.+)" failed to connect: ([\s\S]*)\. Its tools are unavailable [\s\S]*\.$/;

/**
 * Reads omp's connection-failure notice (an `agent_message_chunk` it sends right after
 * `session/new`) back into server and reason. omp offers no structured channel for this; the
 * text is pinned to the installed omp by `mcp-servers.test.ts` (the
 * failing-server case), which breaks if a bump changes it. Returns null for any other text.
 */
export function parseMcpFailure(text: string): { server: string; message: string } | null {
  const match = FAILURE.exec(text);
  return match?.[1] && match[2] !== undefined ? { server: match[1], message: match[2] } : null;
}
