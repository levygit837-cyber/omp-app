import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { statSync } from "node:fs";
import pkg from "../package.json" with { type: "json" };
import { installedOmpVersion, type RunningSidecar, startSidecar } from "./harness";

// Booting omp (theme, natives, ACP agent) takes several seconds on a cold start.
setDefaultTimeout(60_000);

let sidecar: RunningSidecar | undefined;
afterEach(async () => {
  await sidecar?.stop();
  sidecar = undefined;
});

describe("handshake", () => {
  test("reports the omp version installed in node_modules and the sidecar version", async () => {
    sidecar = await startSidecar();
    const client = await sidecar.connect();

    const result = await client.request("handshake");

    const installed = await installedOmpVersion();
    expect(result.ompVersion).toBe(installed);
    // The pin in package.json is what makes the installed version reproducible.
    expect(pkg.dependencies["@oh-my-pi/pi-coding-agent"]).toBe(installed);
    expect(result.sidecarVersion).toBe(pkg.version);
    expect(result.capabilities).toContain("handshake");
  });

  test("listens on a socket only the owner can use", async () => {
    sidecar = await startSidecar();
    expect(statSync(sidecar.socketPath).mode & 0o777).toBe(0o600);
  });

  test("answers an unknown method with a typed error and keeps serving", async () => {
    sidecar = await startSidecar();
    const client = await sidecar.connect();

    // "nope" is not a method of the protocol, so the cast sends a request the server cannot serve.
    await expect(client.request("nope" as "handshake")).rejects.toThrow(/unknown method: nope/);

    expect((await client.request("handshake")).ompVersion).toBe(await installedOmpVersion());
  });

  test("exits when the client disconnects, so a dead app leaves no sidecar", async () => {
    sidecar = await startSidecar();
    const client = await sidecar.connect();
    await client.request("handshake");

    client.close();

    expect(await Promise.race([sidecar.proc.exited, Bun.sleep(10_000).then(() => "timeout")])).toBe(
      0,
    );
  });
});

describe("protocol channel isolation", () => {
  test("stray stdout writes from the sidecar never reach the protocol channel", async () => {
    sidecar = await startSidecar();
    const client = await sidecar.connect();
    const marker = "STRAY-OUTPUT-MARKER";

    const before = await client.request("handshake");
    const debug = await client.request("debug.logStdout", { marker });
    const after = await client.request("handshake");

    // The strays really happened (otherwise the assertions below prove nothing)...
    expect(debug.writes).toBe(3);
    await Bun.sleep(100);
    const logs = sidecar.stdout() + sidecar.stderr();
    expect(logs).toContain(`${marker} console.log`);
    expect(logs).toContain(`${marker} process.stdout.write`);
    expect(logs).toContain(`${marker} fd1`);
    // ...yet the socket carried nothing but well-formed frames: the harness throws on any
    // non-frame line, and the marker never appears on it.
    expect(client.received()).not.toContain(marker);
    expect(after).toEqual(before);
  });

  test("console.log goes to stderr, not stdout", async () => {
    sidecar = await startSidecar();
    const client = await sidecar.connect();
    await client.request("debug.logStdout", { marker: "ROUTE" });
    await Bun.sleep(100);

    expect(sidecar.stderr()).toContain("ROUTE console.log");
    expect(sidecar.stdout()).not.toContain("ROUTE console.log");
  });

  test("debug requests are refused unless debug mode is on", async () => {
    sidecar = await startSidecar({ OMP_APP_SIDECAR_DEBUG: "0" });
    const client = await sidecar.connect();

    await expect(client.request("debug.logStdout", { marker: "x" })).rejects.toThrow(/disabled/);
  });
});
