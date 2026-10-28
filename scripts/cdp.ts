import { type ChildProcess, spawn } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Drives the built Electron app over CDP. Settings, all from the environment:
 *   OMP_APP_REPO  checkout (or worktree) of omp-app with `apps/desktop` built; required
 *   EV_WORK       scratch directory for the temp HOME, project, wrapper and screenshots
 *   EV_PORT       remote debugging port (default 9343)
 */
const repo = process.env.OMP_APP_REPO;
if (!repo) throw new Error("set OMP_APP_REPO to the omp-app checkout that was built");
const DESKTOP = join(repo, "apps/desktop");
const PORT = Number(process.env.EV_PORT ?? 9343);
export const WORK = process.env.EV_WORK ?? join(tmpdir(), "omp-app-evidence");
export const HOME_DIR = join(WORK, "home");
export const PROJECT_DIR = join(WORK, "proj", "payments-api");
export const SHOTS_DIR = join(WORK, "shots");
for (const dir of [HOME_DIR, PROJECT_DIR, SHOTS_DIR]) mkdirSync(dir, { recursive: true });

/** An executable that starts the fake sidecar with the bun that runs this script. */
export function fakeSidecarBin(): string {
  const bin = join(WORK, "fake-sidecar.sh");
  const script = join(DESKTOP, "test/fixtures/fake-sidecar.ts");
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  chmodSync(bin, 0o755);
  return bin;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class App {
  proc!: ChildProcess;
  ws!: WebSocket;
  id = 0;
  pending = new Map<number, (v: any) => void>();
  static async launch(env: Record<string, string>): Promise<App> {
    const app = new App();
    app.proc = spawn("bunx", ["electron", ".", `--remote-debugging-port=${PORT}`], {
      cwd: DESKTOP,
      env: { ...process.env, ...env },
      stdio: "ignore",
    });
    let target: any;
    for (let i = 0; i < 100 && !target; i++) {
      await sleep(300);
      try {
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
        target = list.find((t: any) => t.type === "page");
      } catch {}
    }
    if (!target) throw new Error("no page target");
    app.ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r) => (app.ws.onopen = r));
    app.ws.onmessage = (m) => {
      const d = JSON.parse(String(m.data));
      if (d.id && app.pending.has(d.id)) {
        app.pending.get(d.id)!(d);
        app.pending.delete(d.id);
      }
    };
    await app.send("Page.enable");
    await app.send("Runtime.enable");
    await app.send("Performance.enable");
    return app;
  }
  send(method: string, params: any = {}): Promise<any> {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, (d) => (d.error ? reject(new Error(method + ": " + JSON.stringify(d.error))) : resolve(d.result)));
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval<T = any>(expression: string): Promise<T> {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
    return r.result.value;
  }
  async shot(file: string) {
    const r = await this.send("Page.captureScreenshot", {
      format: "png",
      clip: { x: 0, y: 0, width: 1440, height: 900, scale: 1 },
    });
    await Bun.write(file, Buffer.from(r.data, "base64"));
  }
  async waitFor(expr: string, ms = 15000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await this.eval(`!!(${expr})`).catch(() => false)) return;
      await sleep(150);
    }
    throw new Error("timeout waiting for " + expr);
  }
  /** Start a session in `dir` the way the controller does after a reload: via sessionStorage. */
  async openSession(dir: string) {
    await this.waitFor(`document.querySelector('[data-testid=sidecar-status]')?.dataset.state === 'ready'`);
    const created = await this.eval<any>(`window.omp.session.create(${JSON.stringify(dir)})`);
    const id = typeof created === 'string' ? created : created.sessionId;
    await this.eval(`sessionStorage.setItem('omp-app.openSessions', JSON.stringify({open:[${JSON.stringify(id)}], focused:${JSON.stringify(id)}})); location.reload()`);
    await sleep(800);
    await this.waitFor(`!!document.querySelector('[data-testid=timeline]')`);
    return id;
  }
  async prompt(text: string) {
    await this.eval(`(() => { const t = document.querySelector('[data-testid=prompt-input]'); t.focus();
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      set.call(t, ${JSON.stringify(text)}); t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await sleep(100);
    await this.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  }
  async close() {
    try { this.ws.close(); } catch {}
    this.proc.kill("SIGTERM");
    await sleep(1500);
    Bun.spawnSync(["pkill", "-f", `remote-debugging-port=${PORT}`]);
    Bun.spawnSync(["pkill", "-f", "fixtures/fake-sidecar.ts"]);
    await sleep(500);
  }
}
