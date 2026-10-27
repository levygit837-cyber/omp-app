// Minimal CDP client for the smoke runs: connect(port) -> { eval(expr), shot(path), key(...), close() }
export async function connect(port) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const page = targets.find((t) => t.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const waits = new Map();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && waits.has(d.id)) { waits.get(d.id)(d); waits.delete(d.id); }
  };
  const send = (method, params = {}) => new Promise((res, rej) => {
    const i = ++id;
    waits.set(i, (d) => (d.error ? rej(new Error(JSON.stringify(d.error))) : res(d.result)));
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  return {
    send, sleep,
    async eval(expression) {
      const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
      return r.result.value;
    },
    async shot(path) {
      const r = await send("Page.captureScreenshot", { format: "png" });
      await Bun.write(path, Buffer.from(r.data, "base64"));
    },
    async key(key, { alt = false, code } = {}) {
      const base = { key, code: code ?? key, modifiers: alt ? 1 : 0 };
      const text = key === "Enter" ? "\r" : undefined;
      await send("Input.dispatchKeyEvent", { type: "keyDown", ...base, text, windowsVirtualKeyCode: key === "Enter" ? 13 : key === "Escape" ? 27 : key.charCodeAt(0) });
      await send("Input.dispatchKeyEvent", { type: "keyUp", ...base, windowsVirtualKeyCode: key === "Enter" ? 13 : key === "Escape" ? 27 : key.charCodeAt(0) });
    },
    async viewport(w, h) {
      await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    },
    close() { ws.close(); },
  };
}
