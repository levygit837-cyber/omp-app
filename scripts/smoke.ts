import { App, fakeSidecarBin, HOME_DIR, PROJECT_DIR, SHOTS_DIR, sleep } from "./cdp";
const mode = process.argv[2] ?? "tree";
const app = await App.launch({
  OMP_APP_SIDECAR_BIN: fakeSidecarBin(),
  FAKE_SIDECAR: "ok",
  FAKE_DELEGATION: mode === "perf" ? "frames" : "running",
  FAKE_HOLD: "1",
  FAKE_CHUNK_MS: "40",
  ...(mode === "fail" ? { FAKE_CANCEL_FAILS: "1" } : {}),
  ...(mode === "overflow" ? { FAKE_SUBAGENT_EXTRA: "4" } : {}),
  ...(mode === "odd-id" ? { FAKE_SUBAGENT_ODD_ID: "1" } : {}),
  HOME: HOME_DIR,
});
const shot = (n: string) => app.shot(`${SHOTS_DIR}/${n}.png`);
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
  const id = await app.openSession(PROJECT_DIR);
  await app.waitFor(`document.querySelectorAll('[data-testid=subagent-row]').length >= 3`);
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
  if (mode === "overflow") {
    const geo = () => app.eval(`(() => { const list = document.querySelector('[role=tablist]'); const box = list.getBoundingClientRect();
      return JSON.stringify({ tabs: list.querySelectorAll('[role=tab]').length, scrollWidth: list.scrollWidth, clientWidth: list.clientWidth, scrollLeft: Math.round(list.scrollLeft),
        rightPanelOpen: !!document.body.innerText.includes('Geral'),
        selected: [...list.querySelectorAll('[role=tab]')].map(t => { const r = t.getBoundingClientRect(); return [t.dataset.tabKey, t.getAttribute('aria-selected'), r.left >= box.left - 1 && r.right <= box.right + 1] }).filter(x => x[1] === 'true')[0],
        hidden: [...list.querySelectorAll('[role=tab]')].filter(t => { const r = t.getBoundingClientRect(); return r.right > box.right + 1 || r.left < box.left - 1 }).length }) })()`);
    console.log("initial:", await geo());
    await shot("12-tabs-overflow-initial");
    await click("[data-testid=subagent-row][data-subagent-id=sa-verify]");
    await app.waitFor(`document.querySelector('[data-testid=tabpanel]')`);
    await app.eval(`document.querySelector('[data-tab-key="subagent:sa-verify"]').focus()`);
    await key("End", 35);
    await sleep(500);
    console.log("after End:", await geo());
    console.log("focused tab style:", await app.eval(`(() => { const t = document.activeElement; const c = getComputedStyle(t); const r = t.getBoundingClientRect(); return JSON.stringify({key: t.dataset.tabKey, outline: c.outlineWidth + ' ' + c.outlineStyle + ' ' + c.outlineColor, offset: c.outlineOffset, borderBottom: c.borderBottomColor, rect: [r.left, r.top, r.right, r.bottom].map(Math.round), vis: matchMedia(':focus-visible') && t.matches(':focus-visible')}) })()`));
    await shot("13-tabs-overflow-end");
    for (let i = 0; i < 4; i++) await key("ArrowLeft", 37);
    await sleep(400);
    console.log("after 4x ArrowLeft:", await geo());
    await key("Home", 36);
    await sleep(500);
    console.log("after Home:", await geo());
    await shot("14-tabs-overflow-home");
    // A selection made elsewhere (the sidebar row of the last subagent) brings its tab into view.
    await click("[data-testid=subagent-row][data-subagent-id=sa-extra-4]");
    await sleep(500);
    console.log("after sidebar pick of last:", await geo());
  }
  if (mode === "odd-id") {
    // An id with a quote, a backslash and a bracket must not break the window: nothing may build a
    // CSS selector from it. The first row-count wait above already passed with 3 rows.
    await app.eval(`window.__errors = []; window.addEventListener('error', (e) => window.__errors.push(String(e.message)))`);
    const odd = `[...document.querySelectorAll('[data-testid=subagent-row]')].find((r) => r.dataset.subagentId.includes('auth'))`;
    await app.waitFor(odd);
    await app.eval(`${odd}.click()`);
    await sleep(600);
    const state = () => app.eval(`JSON.stringify({
      rootChildren: document.getElementById('root')?.children.length ?? 0,
      tabs: [...document.querySelectorAll('[role=tab]')].map((t) => [t.dataset.tabKey, t.getAttribute('aria-selected')]),
      errors: window.__errors,
      active: document.activeElement?.dataset?.tabKey ?? document.activeElement?.tagName,
    })`);
    console.log("odd row picked:", await state());
    await shot("16-odd-id-selected");
    await app.eval(`document.querySelector('[role=tab][aria-selected=true]').focus()`);
    await key("Home", 36);
    for (let i = 0; i < 6; i++) await key("ArrowRight", 39);
    await sleep(300);
    console.log("after Home + 6x ArrowRight:", await state());
    // Delete closes the odd tab and focus moves to a neighbour that stays.
    await app.eval(`document.querySelector('[role=tab][data-tab-key*="auth"]').focus()`);
    await key("Delete", 46);
    await sleep(500);
    console.log("after Delete on the odd tab:", await state());
    await shot("17-odd-id-closed");
  }
  if (mode === "merged") {
    // The merged UI (#37 extensions, #40 prompt controls, #41 palette) around a subagent tab.
    const keyMod = async (k: string, code: number, modifiers: number) => {
      await app.send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code: `Key${k.toUpperCase()}`, windowsVirtualKeyCode: code, modifiers });
      await app.send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code: `Key${k.toUpperCase()}`, windowsVirtualKeyCode: code, modifiers });
    };
    const state = () => app.eval(`JSON.stringify({
      palette: !!document.querySelector('[data-testid=command-palette]'),
      running: !!document.querySelector('[aria-label=Running]'),
      selected: document.querySelector('[role=tab][aria-selected=true]')?.dataset.tabKey ?? null,
      active: document.activeElement?.dataset?.tabKey ?? document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName,
      settings: !!document.querySelector('[data-testid=settings-view], [data-testid=settings]'),
      sessionInert: document.querySelector('[data-testid=tabpanel]')?.closest('[inert]') != null,
    })`);
    await app.prompt("Check the payments handshake");
    await sleep(900);
    await click("[data-testid=subagent-row][data-subagent-id=sa-verify]");
    await app.waitFor(`document.querySelector('[data-testid=tabpanel]')`);
    await sleep(700);
    await app.eval(`document.querySelector('[role=tab][aria-selected=true]').focus()`);
    console.log("subagent tab open:", await state());
    await shot("19-merged-subagent-tab");
    await keyMod("k", 75, 4);
    await app.waitFor(`document.querySelector('[data-testid=command-palette]')`);
    await sleep(400);
    console.log("after Cmd+K:", await state());
    await shot("20-palette-over-subagent-tab");
    await key("ArrowDown", 40);
    await key("Escape", 27);
    await sleep(500);
    console.log("after Esc in palette:", await state());
    await click("[data-testid=open-settings]");
    await sleep(700);
    console.log("settings open:", await state());
    await shot("21-settings-over-subagent-tab");
    await key("Escape", 27);
    await sleep(700);
    console.log("after Esc in settings:", await state());
    await shot("22-back-from-settings");
    // Geometry: the tab strip must not overlap anything else in the chrome row.
    console.log("rects:", await app.eval(`JSON.stringify([...document.querySelectorAll('[role=tablist], [data-testid=open-extensions], [data-testid=open-settings]')].map((e) => { const r = e.getBoundingClientRect(); return [e.getAttribute('role') ?? e.dataset.testid, Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)]; }))`));
  }
  if (mode === "confirm-stream") {
    await click("[data-testid=subagent-row][data-subagent-id=sa-verify]");
    await app.waitFor(`document.querySelector('[data-testid=tabpanel]')`);
    await sleep(700);
    await click("[data-testid=tabpanel] button[aria-label^=Stop]");
    await app.waitFor(`document.querySelector('[role=alertdialog]')`);
    const grow = () => app.eval(`document.querySelector('[data-testid=tabpanel] [data-testid=timeline]')?.textContent.length`);
    await app.eval(`window.__scrolls = []; document.addEventListener('scroll', (e) => window.__scrolls.push(e.target.dataset?.testid ?? e.target.nodeName), true)`);
    const before = await grow();
    await sleep(5000);
    const after = await grow();
    console.log("confirm open after 5 s:", await app.eval(`!!document.querySelector('[role=alertdialog]')`), "timeline text grew:", before, "->", after);
    console.log("scroll events during the 5 s:", await app.eval(`JSON.stringify(window.__scrolls.length) + ' ' + JSON.stringify([...new Set(window.__scrolls)])`));
    await shot("15-confirm-on-streaming");
    // A scroll that does move the opener (here: the document, which contains it) still closes the card.
    await app.eval(`document.dispatchEvent(new Event('scroll'))`);
    await sleep(200);
    console.log("confirm after a scroll of an ancestor:", await app.eval(`!!document.querySelector('[role=alertdialog]')`));
  }
} finally {
  if (process.env.KEEP !== "1") await app.close();
}
