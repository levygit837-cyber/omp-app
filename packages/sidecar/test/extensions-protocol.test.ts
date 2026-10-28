import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addMCPServer } from "@oh-my-pi/pi-coding-agent/mcp/config-writer";
import type { MCPServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { SCHEMA_VERSION } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import type { McpChange, McpField, McpListing, McpServerInput } from "@omp-app/protocol";
import { assertServerInput } from "../src/mcp-files";
import { type RawClient, type RunningSidecar, startSidecar } from "./harness";

setDefaultTimeout(60_000);

/** Everything lives in one temp tree: the real ~/.omp is never read or written. */
let root: string;
let agentDir: string;
let project: string;
let sidecar: RunningSidecar | undefined;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "omp-app-ext-")));
  agentDir = join(root, "agent");
  project = join(root, "project");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(project, { recursive: true });
});
afterEach(async () => {
  await sidecar?.stop();
  sidecar = undefined;
  rmSync(root, { recursive: true, force: true });
});

const userFile = () => join(agentDir, "mcp.json");
const projectFile = () => join(project, ".omp", "mcp.json");
const bytes = (file: string) => readFileSync(file, "utf8");
const json = (file: string): Record<string, unknown> => JSON.parse(bytes(file));
const servers = (file: string): Record<string, Record<string, unknown>> =>
  (json(file).mcpServers ?? {}) as Record<string, Record<string, unknown>>;

async function connect(): Promise<RawClient> {
  sidecar = await startSidecar({
    PI_CODING_AGENT_DIR: agentDir,
    HOME: root,
    XDG_DATA_HOME: "",
    XDG_STATE_HOME: "",
  });
  return sidecar.connect();
}

/** A project is named by a session: the sidecar takes the directory from that session's cwd. */
async function openSession(client: RawClient, cwd = project): Promise<string> {
  return (await client.request("session.create", { cwd })).sessionId;
}

const errorOf = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (e: Error & { code?: string }) => e,
  );

const stdioInput = (name: string, extra: Partial<McpServerInput> = {}): McpServerInput => ({
  name,
  transport: "stdio",
  command: "npx",
  args: ["-y", "some-mcp"],
  ...extra,
});

function ok(change: McpChange): McpListing {
  if (!change.ok) throw new Error(`refused: ${change.message}`);
  return change.listing;
}

describe("mcp.list", () => {
  test("lists both scopes with the file each reads, and what a new session will do with a server", async () => {
    writeFileSync(
      userFile(),
      JSON.stringify({
        mcpServers: {
          plain: { command: "node", args: ["a.js"] },
          off: { command: "node", enabled: false },
          denied: { command: "node" },
          forced: { command: "node", enabled: false },
          remote: { type: "sse", url: "https://example.com/sse" },
        },
        disabledServers: ["denied"],
        enabledServers: ["forced"],
      }),
    );
    mkdirSync(join(project, ".omp"));
    writeFileSync(projectFile(), JSON.stringify({ mcpServers: { local: { command: "bun" } } }));
    const client = await connect();
    const sessionId = await openSession(client);

    const user = await client.request("mcp.list", { scope: "global" });
    expect(user.file).toBe(userFile());
    expect(user.servers.map((s) => [s.name, s.transport, s.enabled])).toEqual([
      ["plain", "stdio", true],
      ["off", "stdio", false],
      ["denied", "stdio", false],
      ["forced", "stdio", true],
      ["remote", "sse", true],
    ]);
    expect(user.servers[0]).toMatchObject({ command: "node", args: ["a.js"] });

    const local = await client.request("mcp.list", { scope: "project", sessionId });
    expect(local.file).toBe(projectFile());
    expect(local.servers.map((s) => s.name)).toEqual(["local"]);
  });

  test("a missing file is an empty list, not an error, and is not created", async () => {
    const client = await connect();
    const sessionId = await openSession(client);
    const listing = await client.request("mcp.list", { scope: "project", sessionId });
    expect(listing.servers).toEqual([]);
    expect(listing.error).toBeUndefined();
    expect(existsSync(join(project, ".omp"))).toBe(false);
  });

  test("an entry omp would refuse is listed with omp's sentence", async () => {
    writeFileSync(userFile(), JSON.stringify({ mcpServers: { bad: { type: "http" } } }));
    const client = await connect();
    const listing = await client.request("mcp.list", { scope: "global" });
    expect(listing.servers[0]?.problem).toContain('"url"');
  });
});

describe("writes at both levels", () => {
  test.each(["global", "project"] as const)(
    "add, edit, disable, enable and remove at the %s level, one file each",
    async (scope) => {
      const client = await connect();
      const sessionId = await openSession(client);
      const target = scope === "global" ? { scope } : { scope, sessionId };
      const file = scope === "global" ? userFile() : projectFile();
      const other = scope === "global" ? projectFile() : userFile();

      let listing = ok(await client.request("mcp.add", { ...target, server: stdioInput("tool") }));
      expect(listing.servers.map((s) => s.name)).toEqual(["tool"]);
      expect(servers(file).tool).toEqual({
        type: "stdio",
        command: "npx",
        args: ["-y", "some-mcp"],
      });

      listing = ok(
        await client.request("mcp.update", {
          ...target,
          server: stdioInput("tool", { command: "bunx", args: [] }),
        }),
      );
      expect(servers(file).tool).toEqual({ type: "stdio", command: "bunx" });
      expect(listing.servers[0]?.command).toBe("bunx");

      listing = ok(
        await client.request("mcp.setEnabled", { ...target, name: "tool", enabled: false }),
      );
      expect(listing.servers[0]?.enabled).toBe(false);
      expect(servers(file).tool?.enabled).toBe(false);

      listing = ok(
        await client.request("mcp.setEnabled", { ...target, name: "tool", enabled: true }),
      );
      expect(listing.servers[0]?.enabled).toBe(true);
      expect(servers(file).tool?.enabled).not.toBe(false);

      listing = ok(await client.request("mcp.remove", { ...target, name: "tool" }));
      expect(listing.servers).toEqual([]);
      expect(servers(file)).toEqual({});
      // The other scope's file was never created or touched.
      expect(existsSync(other)).toBe(false);
    },
  );

  test("the file is byte-for-byte what omp's own writer (the CLI's /mcp add) produces", async () => {
    const client = await connect();
    const sessionId = await openSession(client);
    const reference = join(root, "reference.json");
    const cases: Array<[McpServerInput, MCPServerConfig]> = [
      [
        stdioInput("npx-tool"),
        { type: "stdio", command: "npx", args: ["-y", "some-mcp"] } as MCPServerConfig,
      ],
      [
        { name: "bare", transport: "stdio", command: "node" },
        { type: "stdio", command: "node", args: undefined } as MCPServerConfig,
      ],
      [
        {
          name: "remote",
          transport: "http",
          url: "example.com/mcp",
          headers: { Authorization: "Bearer t0k3n" },
        },
        {
          type: "http",
          url: "https://example.com/mcp",
          headers: { Authorization: "Bearer t0k3n" },
        } as MCPServerConfig,
      ],
      [
        { name: "stream", transport: "sse", url: "https://example.com/sse" },
        { type: "sse", url: "https://example.com/sse", headers: undefined } as MCPServerConfig,
      ],
    ];
    for (const [input, config] of cases) {
      ok(await client.request("mcp.add", { scope: "project", sessionId, server: input }));
      await addMCPServer(reference, input.name, config);
    }
    expect(bytes(projectFile())).toBe(bytes(reference));
  });

  test("an edit keeps what the form does not carry: timeout, auth and the stored secrets", async () => {
    writeFileSync(
      userFile(),
      JSON.stringify({
        mcpServers: {
          api: {
            type: "http",
            url: "https://example.com/mcp",
            headers: { Authorization: "Bearer keep-me", "X-Old": "gone" },
            timeout: 9000,
            auth: { type: "oauth" },
          },
        },
      }),
    );
    const client = await connect();
    ok(
      await client.request("mcp.update", {
        scope: "global",
        server: {
          name: "api",
          transport: "http",
          headers: { Authorization: null, "X-New": "added" },
        },
      }),
    );
    expect(servers(userFile()).api).toEqual({
      type: "http",
      url: "https://example.com/mcp",
      headers: { Authorization: "Bearer keep-me", "X-New": "added" },
      timeout: 9000,
      auth: { type: "oauth" },
    });
  });

  test("disabling a server of the project file leaves the user file alone", async () => {
    writeFileSync(userFile(), JSON.stringify({ mcpServers: { same: { command: "u" } } }));
    mkdirSync(join(project, ".omp"));
    writeFileSync(projectFile(), JSON.stringify({ mcpServers: { same: { command: "p" } } }));
    const before = bytes(userFile());
    const client = await connect();
    const sessionId = await openSession(client);
    const listing = ok(
      await client.request("mcp.setEnabled", {
        scope: "project",
        sessionId,
        name: "same",
        enabled: false,
      }),
    );
    expect(listing.servers[0]?.enabled).toBe(false);
    expect(bytes(userFile())).toBe(before);
  });

  test("a server turned off through the user denylist is turned back on", async () => {
    writeFileSync(
      userFile(),
      JSON.stringify({ mcpServers: { x: { command: "n" } }, disabledServers: ["x"] }),
    );
    const client = await connect();
    expect((await client.request("mcp.list", { scope: "global" })).servers[0]?.enabled).toBe(false);
    const listing = ok(
      await client.request("mcp.setEnabled", { scope: "global", name: "x", enabled: true }),
    );
    expect(listing.servers[0]?.enabled).toBe(true);
  });
});

describe("refusals are sentences, with the field they are about", () => {
  test("omp's validation, a duplicate and a missing server leave the file as it was", async () => {
    const client = await connect();
    ok(await client.request("mcp.add", { scope: "global", server: stdioInput("one") }));
    const before = bytes(userFile());

    const cases: Array<[Promise<McpChange>, McpField | undefined, RegExp]> = [
      [
        client.request("mcp.add", {
          scope: "global",
          server: { name: "nocmd", transport: "stdio", command: "  " },
        }),
        "command",
        /command/,
      ],
      [
        client.request("mcp.add", {
          scope: "global",
          server: { name: "nourl", transport: "http", url: "" },
        }),
        "url",
        /url/,
      ],
      [
        client.request("mcp.add", { scope: "global", server: stdioInput("bad name!") }),
        "name",
        /name/i,
      ],
      [
        client.request("mcp.add", { scope: "global", server: stdioInput("one") }),
        "name",
        /already exists/,
      ],
      [
        client.request("mcp.update", { scope: "global", server: stdioInput("ghost") }),
        undefined,
        /no server named/,
      ],
      [
        client.request("mcp.remove", { scope: "global", name: "ghost" }),
        undefined,
        /no server named/,
      ],
      [
        client.request("mcp.setEnabled", { scope: "global", name: "ghost", enabled: false }),
        undefined,
        /no server named/,
      ],
      [
        client.request("mcp.add", {
          scope: "global",
          server: {
            name: "hdr",
            transport: "http",
            url: "https://example.com",
            headers: { "bad header": "v" },
          },
        }),
        "headers",
        /header/,
      ],
    ];
    for (const [pending, field, message] of cases) {
      const change = await pending;
      expect(change.ok).toBe(false);
      if (change.ok) continue;
      expect(change.message).toMatch(message);
      expect(change.field).toBe(field);
      // A sentence for the person, never a stack or an error class.
      expect(change.message).not.toMatch(/^Error|\bat .*\(/);
    }
    expect(bytes(userFile())).toBe(before);
  });

  test("a malformed argument is a protocol error, not a refusal", async () => {
    const client = await connect();
    const bad = await errorOf(
      client.request("mcp.add", {
        scope: "global",
        server: { name: "x", transport: "carrier-pigeon" } as unknown as McpServerInput,
      }),
    );
    expect(bad?.code).toBe("internal");
    expect(
      (
        await errorOf(
          client.request("mcp.remove", { scope: "global", name: 3 as unknown as string }),
        )
      )?.code,
    ).toBe("internal");
  });
});

describe("secrets", () => {
  const secrets = {
    env: "env-secret-7731",
    header: "header-secret-9042",
    userinfo: "user:pw-secret-5518",
    query: "query-secret-2260",
  };

  test("no listing carries a stored value; reveal hands out one on demand", async () => {
    writeFileSync(
      userFile(),
      JSON.stringify({
        mcpServers: {
          local: { command: "node", env: { API_KEY: secrets.env } },
          remote: {
            type: "http",
            url: `https://${secrets.userinfo}@example.com/mcp?token=${secrets.query}&v=2`,
            headers: { Authorization: secrets.header },
          },
        },
      }),
    );
    const client = await connect();
    const listing = await client.request("mcp.list", { scope: "global" });
    const text = JSON.stringify(listing);
    for (const secret of Object.values(secrets)) expect(text).not.toContain(secret);
    const [local, remote] = listing.servers;
    expect(local?.envKeys).toEqual(["API_KEY"]);
    expect(remote?.headerKeys).toEqual(["Authorization"]);
    expect(remote).toMatchObject({
      urlRedacted: true,
      url: "https://•••@example.com/mcp?token=•••&v=•••",
    });

    expect(
      await client.request("mcp.reveal", {
        scope: "global",
        name: "local",
        secret: { kind: "env", key: "API_KEY" },
      }),
    ).toEqual({ value: secrets.env });
    expect(
      await client.request("mcp.reveal", {
        scope: "global",
        name: "remote",
        secret: { kind: "header", key: "Authorization" },
      }),
    ).toEqual({ value: secrets.header });
    expect(
      await client.request("mcp.reveal", {
        scope: "global",
        name: "remote",
        secret: { kind: "url" },
      }),
    ).toEqual({
      value: `https://${secrets.userinfo}@example.com/mcp?token=${secrets.query}&v=2`,
    });
    for (const secret of [
      { kind: "env", key: "NOPE" },
      { kind: "header", key: "API_KEY" },
    ] as const) {
      const failure = await errorOf(
        client.request("mcp.reveal", { scope: "global", name: "local", secret }),
      );
      expect(failure?.code).toBe("internal");
    }
  });

  test("a URL secret is hidden wherever it sits: bare query pair, fragment, no scheme", async () => {
    writeFileSync(
      userFile(),
      JSON.stringify({
        mcpServers: {
          bare: { type: "http", url: "https://h.example/mcp?tok3nvalue-4471" },
          frag: { type: "http", url: "https://h.example/mcp#access_token=frag-secret-8890" },
          bare2: { type: "http", url: "https://h.example/mcp?a=1&tok3nvalue-4472&b=2" },
          scheme: { type: "http", url: "h.example/mcp?key=noscheme-secret-1203" },
          schemeFrag: { type: "http", url: "h.example/mcp#frag-secret-7765" },
          plain: { type: "http", url: "https://h.example/mcp" },
        },
      }),
    );
    const client = await connect();
    const listing = await client.request("mcp.list", { scope: "global" });
    const text = JSON.stringify(listing);
    for (const secret of [
      "tok3nvalue-4471",
      "frag-secret-8890",
      "tok3nvalue-4472",
      "noscheme-secret-1203",
      "frag-secret-7765",
    ]) {
      expect(text).not.toContain(secret);
    }
    const byName = Object.fromEntries(listing.servers.map((s) => [s.name, s]));
    expect(byName.bare).toMatchObject({ urlRedacted: true, url: "https://h.example/mcp?•••" });
    expect(byName.bare2?.url).toBe("https://h.example/mcp?a=•••&•••&b=•••");
    expect(byName.frag).toMatchObject({ urlRedacted: true, url: "https://h.example/mcp#•••" });
    expect(byName.scheme).toMatchObject({ urlRedacted: true });
    expect(byName.plain).toMatchObject({ urlRedacted: false, url: "https://h.example/mcp" });
    // The value is still there for the person who asks.
    expect(
      await client.request("mcp.reveal", {
        scope: "global",
        name: "bare",
        secret: { kind: "url" },
      }),
    ).toEqual({ value: "https://h.example/mcp?tok3nvalue-4471" });
  });

  test("a write's answer does not carry the values it just stored", async () => {
    const client = await connect();
    const change = await client.request("mcp.add", {
      scope: "global",
      server: {
        name: "fresh",
        transport: "http",
        url: `https://${secrets.userinfo}@example.com/mcp`,
        headers: { Authorization: secrets.header },
      },
    });
    const text = JSON.stringify(change);
    expect(change.ok).toBe(true);
    expect(text).not.toContain(secrets.header);
    expect(text).not.toContain(secrets.userinfo);
    expect(servers(userFile()).fresh?.headers).toEqual({ Authorization: secrets.header });
  });
});

describe("confinement", () => {
  test("the project directory comes from the session; the home directory lists but is never written", async () => {
    const homeFile = join(root, ".omp", "mcp.json");
    mkdirSync(join(root, ".omp"), { recursive: true });
    writeFileSync(homeFile, JSON.stringify({ mcpServers: { homeproj: { command: "node" } } }));
    const before = bytes(homeFile);
    const client = await connect();
    const homeSession = await openSession(client, root);
    // omp starts the servers of <home>/.omp/mcp.json as project servers, so the list shows them.
    const listing = await client.request("mcp.list", { scope: "project", sessionId: homeSession });
    expect(listing.file).toBe(homeFile);
    expect(listing.servers.map((s) => s.name)).toEqual(["homeproj"]);
    expect(listing.locked).toContain("home directory");

    for (const change of [
      await client.request("mcp.add", {
        scope: "project",
        sessionId: homeSession,
        server: stdioInput("nope"),
      }),
      await client.request("mcp.remove", {
        scope: "project",
        sessionId: homeSession,
        name: "homeproj",
      }),
      await client.request("mcp.setEnabled", {
        scope: "project",
        sessionId: homeSession,
        name: "homeproj",
        enabled: false,
      }),
    ]) {
      expect(change.ok).toBe(false);
    }
    expect(bytes(homeFile)).toBe(before);
    expect(existsSync(join(root, ".omp", "mcp.json.lock"))).toBe(false);
  });

  test("a project whose servers omp is told not to start lists them as inactive", async () => {
    writeFileSync(join(agentDir, "config.yml"), "mcp:\n  enableProjectConfig: false\n");
    mkdirSync(join(project, ".omp"), { recursive: true });
    writeFileSync(projectFile(), JSON.stringify({ mcpServers: { projonly: { command: "node" } } }));
    const client = await connect();
    const sessionId = await openSession(client);
    const listing = await client.request("mcp.list", { scope: "project", sessionId });
    expect(listing.inactive).toContain("enableProjectConfig");
    expect(listing.servers.map((s) => s.name)).toEqual(["projonly"]);
    const global = await client.request("mcp.list", { scope: "global", sessionId });
    expect(global.inactive).toBeUndefined();
  });

  test("an unknown session, a missing session and an unknown scope are refused", async () => {
    const client = await connect();
    const unknown = await errorOf(
      client.request("mcp.list", {
        scope: "project",
        sessionId: "00000000-0000-0000-0000-000000000000",
      }),
    );
    const missing = await errorOf(client.request("mcp.list", { scope: "project" }));
    const scope = await errorOf(
      client.request("mcp.list", { scope: "../etc" as unknown as "global" }),
    );
    expect([unknown?.code, missing?.code, scope?.code]).toEqual([
      "internal",
      "internal",
      "internal",
    ]);
    expect(existsSync(join(project, ".omp"))).toBe(false);
  });

  test("a server name that looks like a path cannot move the write", async () => {
    const client = await connect();
    const sessionId = await openSession(client);
    const change = await client.request("mcp.add", {
      scope: "project",
      sessionId,
      server: stdioInput("../../escape"),
    });
    expect(change.ok).toBe(false);
    expect(existsSync(join(root, "escape"))).toBe(false);
    expect(existsSync(projectFile())).toBe(false);
  });
});

describe("a name is only a server if the file holds it", () => {
  test("removing one that is not there leaves no directory and no lock behind", async () => {
    const client = await connect();
    const sessionId = await openSession(client);
    const change = await client.request("mcp.remove", {
      scope: "project",
      sessionId,
      name: "ghost",
    });
    expect(change).toMatchObject({ ok: false });
    expect(existsSync(join(project, ".omp"))).toBe(false);
    const global = await client.request("mcp.remove", { scope: "global", name: "ghost" });
    expect(global.ok).toBe(false);
    expect(existsSync(userFile())).toBe(false);
    expect(existsSync(`${userFile()}.lock`)).toBe(false);
  });

  test("names every object inherits are not servers", async () => {
    const client = await connect();
    const sessionId = await openSession(client);
    const inherited = ["toString", "constructor", "hasOwnProperty", "__proto__"];
    for (const name of inherited) {
      for (const change of [
        await client.request("mcp.remove", { scope: "project", sessionId, name }),
        await client.request("mcp.update", {
          scope: "project",
          sessionId,
          server: stdioInput(name),
        }),
        await client.request("mcp.setEnabled", {
          scope: "project",
          sessionId,
          name,
          enabled: false,
        }),
      ]) {
        expect(change.ok).toBe(false);
      }
      const failure = await errorOf(
        client.request("mcp.reveal", {
          scope: "project",
          sessionId,
          name,
          secret: { kind: "url" },
        }),
      );
      expect(failure?.code).toBe("internal");
    }
    expect(existsSync(join(project, ".omp"))).toBe(false);
  });
});

describe("the sidecar re-checks the form's size limits", () => {
  // Pure on purpose: the test harness writes a frame with one `socket.write` and drops what the
  // kernel buffer does not take, so a frame this large cannot cross it.
  const refuses = (server: McpServerInput) => {
    try {
      assertServerInput(server);
      return null;
    } catch (error) {
      return (error as Error).message;
    }
  };

  test("an oversized name, command, argument list or value is refused; a normal one is not", () => {
    const tooMany = Object.fromEntries(Array.from({ length: 129 }, (_, i) => [`K${i}`, "v"]));
    expect(refuses(stdioInput("ok", { args: ["--flag", "a".repeat(8192)] }))).toBeNull();
    const refused = {
      name: refuses(stdioInput("x".repeat(101))),
      argCount: refuses(stdioInput("big", { args: Array.from({ length: 257 }, () => "a") })),
      argLength: refuses(stdioInput("big", { args: ["a".repeat(8193)] })),
      command: refuses(stdioInput("big", { command: "c".repeat(4097) })),
      envValue: refuses(stdioInput("big", { env: { K: "v".repeat(16385) } })),
      envCount: refuses(stdioInput("big", { env: tooMany })),
    };
    expect(Object.values(refused).every((m) => typeof m === "string")).toBe(true);
  });

  test("the socket refuses a name that is too long and writes nothing", async () => {
    const client = await connect();
    const failure = await errorOf(
      client.request("mcp.add", { scope: "global", server: stdioInput("x".repeat(101)) }),
    );
    expect(failure?.code).toBe("internal");
    expect(existsSync(userFile())).toBe(false);
  });
});

describe("files that cannot be used as they are", () => {
  test("a malformed mcp.json is a sentence, never its contents, and the file is untouched", async () => {
    const secret = "sk-do-not-echo-0042";
    const body = `{"mcpServers": {"a": {"command": "x", "env": {"K": "${secret}"}}, `;
    writeFileSync(userFile(), body);
    const client = await connect();

    const listing = await client.request("mcp.list", { scope: "global" });
    expect(listing.servers).toEqual([]);
    expect(listing.error).toBeDefined();
    expect(JSON.stringify(listing)).not.toContain(secret);

    for (const change of [
      await client.request("mcp.add", { scope: "global", server: stdioInput("n") }),
      await client.request("mcp.remove", { scope: "global", name: "a" }),
      await client.request("mcp.setEnabled", { scope: "global", name: "a", enabled: false }),
    ]) {
      expect(change.ok).toBe(false);
      expect(JSON.stringify(change)).not.toContain(secret);
    }
    expect(bytes(userFile())).toBe(body);
  });

  test("valid JSON of the wrong shape is refused the same way", async () => {
    writeFileSync(userFile(), "[1, 2]");
    const client = await connect();
    const listing = await client.request("mcp.list", { scope: "global" });
    expect(listing.error).toBeDefined();
    expect((await client.request("mcp.add", { scope: "global", server: stdioInput("n") })).ok).toBe(
      false,
    );
    expect(bytes(userFile())).toBe("[1, 2]");
  });
});

describe("concurrent writes", () => {
  test("writes from the app and from another process through omp's config lock all land", async () => {
    const client = await connect();
    const names = Array.from({ length: 6 }, (_, i) => `app${i}`);
    const others = Array.from({ length: 6 }, (_, i) => `cli${i}`);
    await Promise.all([
      ...names.map((name) =>
        client.request("mcp.add", { scope: "global", server: stdioInput(name) }).then(ok),
      ),
      // The CLI's own writer, in another process than the sidecar's: same lock file.
      ...others.map((name) =>
        addMCPServer(userFile(), name, { type: "stdio", command: "node" } as MCPServerConfig),
      ),
    ]);
    expect(Object.keys(servers(userFile())).sort()).toEqual([...names, ...others].sort());
    const listing = await client.request("mcp.list", { scope: "global" });
    expect(listing.servers).toHaveLength(12);
  });
});

describe("read_only mode", () => {
  test("a newer shared schema refuses every write, still lists and reveals, and touches no file", async () => {
    const db = new Database(join(agentDir, "agent.db"), { create: true });
    db.run("CREATE TABLE schema_version (version INTEGER PRIMARY KEY)");
    db.run("INSERT INTO schema_version(version) VALUES (?)", [SCHEMA_VERSION + 1]);
    db.close();
    const body = JSON.stringify({ mcpServers: { a: { command: "x", env: { K: "ro-secret" } } } });
    writeFileSync(userFile(), body);

    const client = await connect();
    expect((await client.request("handshake")).mode).toBe("read_only");

    const results = await Promise.all([
      errorOf(client.request("mcp.add", { scope: "global", server: stdioInput("n") })),
      errorOf(client.request("mcp.update", { scope: "global", server: stdioInput("a") })),
      errorOf(client.request("mcp.remove", { scope: "global", name: "a" })),
      errorOf(client.request("mcp.setEnabled", { scope: "global", name: "a", enabled: false })),
      errorOf(client.request("skills.setEnabled", { name: "any", enabled: false })),
    ]);
    expect(results.map((e) => e?.code)).toEqual(Array(5).fill("read_only"));
    expect(bytes(userFile())).toBe(body);

    const listing = await client.request("mcp.list", { scope: "global" });
    expect(listing.servers.map((s) => s.name)).toEqual(["a"]);
    expect(
      await client.request("mcp.reveal", {
        scope: "global",
        name: "a",
        secret: { kind: "env", key: "K" },
      }),
    ).toEqual({ value: "ro-secret" });
    expect((await client.request("skills.list", {})).skills).toBeInstanceOf(Array);
  });
});

describe("skills", () => {
  const skill = (dir: string, name: string, description: string) => {
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(
      join(dir, name, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${description}\n---\nBody of ${name}.\n`,
    );
  };
  const config = () => join(agentDir, "config.yml");

  test("lists user and project skills with their origin, and the toggle writes omp's own setting", async () => {
    skill(join(agentDir, "skills"), "mine", "A user skill");
    skill(join(project, ".omp", "skills"), "local", "A project skill");
    const client = await connect();
    const sessionId = await openSession(client);

    const listing = await client.request("skills.list", { sessionId });
    const mine = listing.skills.find((s) => s.name === "mine");
    const local = listing.skills.find((s) => s.name === "local");
    expect(mine).toMatchObject({ origin: "user", state: "active", toggleable: true });
    expect(mine?.description).toBe("A user skill");
    expect(local).toMatchObject({ origin: "project", state: "active" });
    // Without a session the project's skills are not part of the list.
    const bare = await client.request("skills.list", {});
    expect(bare.skills.map((s) => s.name)).toContain("mine");
    expect(bare.skills.map((s) => s.name)).not.toContain("local");

    const off = await client.request("skills.setEnabled", {
      sessionId,
      name: "mine",
      enabled: false,
    });
    expect(off.ok).toBe(true);
    if (!off.ok) return;
    expect(off.listing.skills.find((s) => s.name === "mine")).toMatchObject({
      state: "disabled",
      toggleable: true,
    });
    expect(bytes(config())).toContain("skill:mine");
    expect(bytes(config())).not.toContain("skill:local");

    const on = await client.request("skills.setEnabled", {
      sessionId,
      name: "mine",
      enabled: true,
    });
    expect(on.ok && on.listing.skills.find((s) => s.name === "mine")?.state).toBe("active");
    expect(bytes(config())).not.toContain("skill:mine");
  });

  test("a skill that does not exist, or one that is switched off by its source, is refused", async () => {
    const client = await connect();
    const ghost = await client.request("skills.setEnabled", { name: "ghost", enabled: false });
    expect(ghost.ok).toBe(false);
    if (!ghost.ok) expect(ghost.message).toContain("ghost");
    expect(existsSync(config())).toBe(false);
  });

  test("a project that keeps its own disabled list is not overridden", async () => {
    skill(join(agentDir, "skills"), "mine", "A user skill");
    mkdirSync(join(project, ".omp"));
    writeFileSync(join(project, ".omp", "config.yml"), "disabledExtensions:\n  - skill:other\n");
    const client = await connect();
    const sessionId = await openSession(client);
    const change = await client.request("skills.setEnabled", {
      sessionId,
      name: "mine",
      enabled: false,
    });
    expect(change.ok).toBe(false);
    if (!change.ok) expect(change.message).toContain(".omp/config.yml");
    expect(existsSync(config())).toBe(false);
  });
});
