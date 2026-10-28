import { App, sleep } from "./cdp";
const mode = process.argv[2] ?? "tree";
const app = await App.launch({
  OMP_APP_SIDECAR_BIN: "/tmp/ev16/fake.sh",
  FAKE_SIDECAR: "ok",
  FAKE_DELEGATION: mode === "perf" ? "frames" : "running",
  FAKE_HOLD: "1",
  FAKE_CHUNK_MS: "40",
  ...(mode === "fail" ? { FAKE_CANCEL_FAILS: "1" } : {}),
  HOME: "/tmp/ev16/home",
});
const shot = (n: string) => app.shot(`/tmp/ev16/shots/${n}.png`);
const click = (sel: string) => app.eval(`document.querySelector(${JSON.stringify(sel)}).click()`);
const key = async (k: string, code: number) => {
  await app.send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code: k, windowsVirtualKeyCode: code });
  await app.send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code: k, windowsVirtualKeyCode: code });
};
const snap = () => app.eval(`JSON.stringify({
  tabs: [...document.querySelectorAll('[data-testid=session-tab]')].map(t => [t.dataset.tabKey, t.getAttribute('aria-selected'), t.tabIndex, t.getAttribute('aria-label')]),
  rows: [...document.querySelectorAll('[data-testid=subagent-row]')].map(r => [r.dataset.subagentId, r.dataset.status, r.getAttribute('aria-label')]),
  strip: [...document.querySelectorAll('[data-testid^=delegation-]')].map(b => b.textContent),
  panel: !!document.querySelector('[data-testid=tabpanel]'),
  active: document.activeElement?.getAttribute('data-tab-key') ?? document.activeElement?.tagName,
})`);
try {
  await app.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  const id = await app.openSession("/tmp/ev16/proj/payments-api");
  await app.waitFor(`document.querySelectorAll('[data-testid=subagent-row]').length === 3`);
  await sleep(1200);
  console.log("tree:", await snap());
  await shot("01-tree");
  if (mode === "tree") {
    await app.prompt("Check the payments handshake");
    await app.waitFor(`document.querySelector('[data-testid=engine-slot], [aria-label=Running]')`).catch(() => {});
    await sleep(900);
    await shot("02-turn-running");
    await key("Escape", 27);
    await sleep(900);
    console.log("after esc:", await snap());
    await shot("03-esc-leaves-alive");
    await click("[data-testid=subagent-row][data-subagent-id=sa-verify]");
    await app.waitFor(`document.querySelector('[data-testid=tabpanel]')`);
    await sleep(900);
    console.log("open subagent:", await snap());
    await shot("04-subagent-timeline");
    await app.eval(`document.querySelector('[data-tab-key="subagent:sa-verify"]').focus()`);
    await key("ArrowRight", 39);
    await sleep(200);
    console.log("arrow right:", await snap());
    await key("End", 35);
    await sleep(200);
    console.log("end:", await snap());
    await shot("05-job-tab");
    await click("[data-testid=tabpanel] button[aria-label^=Stop]");
    await app.waitFor(`document.querySelector('[role=alertdialog]')`);
    await sleep(300);
    await shot("06-confirm");
    console.log("confirm focus:", await app.eval(`document.activeElement?.textContent`));
    await key("Escape", 27);
    await sleep(300);
    console.log("after cancel confirm:", await app.eval(`JSON.stringify({dialog: !!document.querySelector('[role=alertdialog]'), job: [...document.querySelectorAll('[data-testid=session-tab]')].map(t=>t.getAttribute('aria-label'))})`));
    await click("[data-testid=tabpanel] button[aria-label^=Stop]");
    await app.waitFor(`document.querySelector('[role=alertdialog]')`);
    await app.eval(`[...document.querySelectorAll('[role=alertdialog] button')].find(b => b.textContent.trim().startsWith('Stop')).click()`);
    await sleep(900);
    console.log("job killed:", await snap());
    await shot("07-job-killed");
  }
  if (mode === "kill" || mode === "fail") {
    await click("[data-testid=subagent-row][data-subagent-id=sa-verify]");
    await app.waitFor(`document.querySelector('[data-testid=tabpanel]')`);
    await click("[data-testid=tabpanel] button[aria-label^=Stop]");
    await app.waitFor(`document.querySelector('[role=alertdialog]')`);
    await app.eval(`[...document.querySelectorAll('[role=alertdialog] button')].find(b => b.textContent.trim().startsWith('Stop')).click()`);
    await sleep(1000);
    console.log(mode, await snap());
    console.log("notice:", await app.eval(`document.querySelector('[data-testid=kill-error]')?.textContent ?? null`));
    await shot(mode === "kill" ? "08-subagent-killed" : "09-stop-failed");
  }
  if (mode === "perf") {
    const recorder = `(() => { const g = []; let last = performance.now(); const tick = (t) => { g.push(t - last); last = t; window.__raf = requestAnimationFrame(tick); }; window.__gaps = g; window.__raf = requestAnimationFrame(tick); })()`;
    const stats = (label: string) => app.eval(`(() => { cancelAnimationFrame(window.__raf); const g = window.__gaps.slice(2).sort((a,b)=>a-b); return ${JSON.stringify(label)} + ' frames=' + g.length + ' p50=' + g[Math.floor(g.length/2)].toFixed(1) + ' p95=' + g[Math.floor(g.length*0.95)].toFixed(1) + ' max=' + g[g.length-1].toFixed(1) + ' over50=' + g.filter(x=>x>50).length })()`);
    await app.prompt("Check the payments handshake");
    await sleep(600);
    // Baseline: the main chat streams, the burst view is not open.
    await app.eval(recorder);
    await sleep(2500);
    console.log(await stats("baseline main streaming  "));
    // Burst: the same stream while sa-verify's 400-frame view opens and fills.
    await app.eval(recorder);
    await click("[data-testid=subagent-row][data-subagent-id=sa-verify]");
    await app.waitFor(`document.querySelector('[data-testid=tabpanel]')`);
    await sleep(2500);
    console.log(await stats("burst view open          "));
    await shot("10-burst-subagent");
    console.log("items in burst view:", await app.eval(`document.querySelectorAll('[data-testid=tabpanel] [data-testid=timeline] *').length`));
    await app.eval(`document.querySelector('[data-tab-key=main]').click()`);
    await sleep(500);
    console.log("main back:", await app.eval(`!!document.querySelector('[data-testid=timeline]')`));
  }
  if (mode === "esc-tab") {
    await app.prompt("Check the payments handshake");
    await sleep(900);
    const status = () => app.eval(`document.querySelector('[data-testid=session-status]')?.textContent ?? document.querySelector('[aria-label=Running]') ? 'running' : 'idle'`);
    console.log("before:", await status());
    await click("[data-testid=subagent-row][data-subagent-id=sa-verify]");
    await app.waitFor(`document.querySelector('[data-testid=tabpanel]')`);
    await key("Escape", 27);
    await sleep(900);
    console.log("after esc on subagent tab:", await status(), JSON.stringify(await app.eval(`!!document.querySelector('[aria-label=Running]')`)));
    await app.eval(`document.querySelector('[data-tab-key=main]').click()`);
    await sleep(500);
    console.log("main still streaming:", await app.eval(`!!document.querySelector('[aria-label=Running]')`));
  }
} finally {
  if (process.env.KEEP !== "1") await app.close();
}
