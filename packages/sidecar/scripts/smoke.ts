/**
 * Post-build check: runs the compiled binary the way a fresh machine would and handshakes with
 * it. HOME and PI_NATIVES_DIR point at empty temp dirs, so the only place the native addon can
 * come from is the one embedded in the binary. If an omp loader change breaks embedding, the
 * build fails here instead of the packaged app failing for users.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeFrame,
  FrameDecoder,
  isResponseEnvelope,
  PROTOCOL_VERSION,
  RequestCorrelator,
} from "@omp-app/protocol";

export async function smokeTestBinary(binary: string, expectedOmpVersion: string): Promise<void> {
  const temp = mkdtempSync(join(tmpdir(), "omp-app-smoke-"));
  const runtimeDir = mkdtempSync(join(tmpdir(), `omp-app-${process.pid}-`));
  const home = join(temp, "home");
  const natives = join(temp, "natives");
  const socketPath = join(runtimeDir, "s.sock");
  const proc = Bun.spawn([binary, `--socket=${socketPath}`], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    // Nothing from the developer's environment: no node_modules, no ~/.omp, no PATH tricks.
    env: { PATH: process.env.PATH ?? "", HOME: home, PI_NATIVES_DIR: natives },
  });
  const stderr = new Response(proc.stderr).text();
  void new Response(proc.stdout).text();
  try {
    const deadline = Date.now() + 90_000;
    while (!existsSync(socketPath)) {
      if (proc.exitCode !== null) throw new Error(`exited before listening:\n${await stderr}`);
      if (Date.now() > deadline) throw new Error("did not listen within 90 s");
      await Bun.sleep(100);
    }
    const correlator = new RequestCorrelator();
    const decoder = new FrameDecoder();
    const text = new TextDecoder();
    const socket = await Bun.connect({
      unix: socketPath,
      socket: {
        data(_s, chunk) {
          for (const line of decoder.push(text.decode(chunk, { stream: true }))) {
            const frame = decodeFrame(line);
            if (frame.ok && isResponseEnvelope(frame.envelope)) correlator.receive(frame.envelope);
          }
        },
      },
    });
    const { frame, response } = correlator.create("handshake");
    socket.write(frame);
    const result = await Promise.race([
      response,
      Bun.sleep(30_000).then(() => {
        throw new Error("no handshake answer within 30 s");
      }),
    ]);
    socket.end();
    if (result.ompVersion !== expectedOmpVersion) {
      throw new Error(`binary reports omp ${result.ompVersion}, expected ${expectedOmpVersion}`);
    }
    if (result.protocolVersion !== PROTOCOL_VERSION) {
      throw new Error(`binary speaks protocol ${result.protocolVersion}, not ${PROTOCOL_VERSION}`);
    }
    // The embedded addon is extracted into PI_NATIVES_DIR/<version>/: proof it was not found elsewhere.
    if (!existsSync(natives) || readdirSync(natives).length === 0) {
      throw new Error(
        `no native addon was extracted into ${natives}: embedding did not take effect`,
      );
    }
  } finally {
    proc.kill();
    await proc.exited;
    rmSync(temp, { recursive: true, force: true });
    rmSync(runtimeDir, { recursive: true, force: true });
  }
}
