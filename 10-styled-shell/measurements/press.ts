import { App, sleep } from "./cdp";
const PROJ = "/Users/levy/Documents/Workspace/Projects/Developer-Tools/omp-app-worktrees/10-styled-shell";
const scenario = process.argv[2]; // scrollbar-stream | selection-stream | selection-idle | scrollbar-idle
const stream = scenario.endsWith("stream");
const words = Array.from({ length: 900 }, (_, i) => `word${i % 97}`).join(" ");
const a = await App.launch({
  OMP_APP_SIDECAR_BIN: "/tmp/ev10/fake.sh", FAKE_SIDECAR: "ok", FAKE_ITEMS: "200",
  FAKE_CHUNK_MS: "60", FAKE_REPLY: words,
});
await a.openSession(PROJ);
await sleep(1500);
await a.eval(`(() => { window.__s = []; window.__phase = "setup";
  const t = document.querySelector('[data-testid=timeline]');
  const tick = () => { window.__s.push([performance.now(), window.__phase, Math.round(t.scrollTop), t.scrollHeight, Math.round(t.scrollHeight - t.clientHeight - t.scrollTop) + 0]); requestAnimationFrame(tick); };
  tick(); })()`);
await a.eval(`(() => { window.__ev = []; for (const n of ["pointerdown","pointerup","pointercancel","mousedown","mouseup","lostpointercapture","click"]) window.addEventListener(n, (e) => window.__ev.push([n, window.__phase, e.target === document.querySelector('[data-testid=timeline]') ? "timeline" : e.target.tagName, Math.round(e.clientX), Math.round(e.clientY)]), true); })()`);
await a.eval(`(() => { window.__w = [];
  const d = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
  Object.defineProperty(Element.prototype, "scrollTop", { ...d, set(v) { if (this.dataset && this.dataset.testid === "timeline") window.__w.push(["hook", window.__phase]); d.set.call(this, v); } });
  const st = Element.prototype.scrollTo;
  Element.prototype.scrollTo = function (...x) { if (this.dataset && this.dataset.testid === "timeline") window.__w.push(["virtualizer", window.__phase]); return st.apply(this, x); }; })()`);
const phase = (p: string) => a.eval(`window.__phase = ${JSON.stringify(p)}`);
const geo = () => a.eval<any>(`(() => { const t = document.querySelector('[data-testid=timeline]'); const r = t.getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.left + t.offsetWidth, bottom: r.bottom, h: t.clientHeight, sh: t.scrollHeight, st: t.scrollTop, cw: t.clientWidth, ow: t.offsetWidth }; })()`);
const mouse = (type: string, x: number, y: number, buttons = 0) =>
  a.send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" && !buttons ? "none" : "left", buttons, clickCount: type === "mouseMoved" ? 0 : 1 });
if (stream) { await a.prompt("Write a long answer."); await sleep(2500); }
await phase("following");
await sleep(600);
if (!stream) { await a.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 700, y: 300, deltaX: 0, deltaY: -10 }); await sleep(100); }
let g = await geo();
console.log("geometry", JSON.stringify(g));
const thumb = () => { const th = Math.max(30, (g.h * g.h) / g.sh); const top = g.top + (g.st / (g.sh - g.h)) * (g.h - th); return { y: top + th / 2, th }; };
let pressX: number, pressY: number, dragY: number;
if (scenario.startsWith("scrollbar")) {
  pressX = g.right - 3; const t = thumb(); pressY = t.y; dragY = pressY - 250;
  await mouse("mouseMoved", pressX, pressY); await sleep(150); g = await geo();
  const t2 = thumb(); pressY = t2.y; dragY = pressY - 250;
} else {
  const pt = await a.eval<any>(`(() => { const t = document.querySelector('[data-testid=timeline]'); const r = t.getBoundingClientRect();
    const rows = [...t.querySelectorAll('p,span,div')].filter(e => e.children.length === 0 && e.textContent.trim().length > 8 && e.getBoundingClientRect().bottom < r.bottom - 10 && e.getBoundingClientRect().top > r.top + 60 && e.getBoundingClientRect().width > 80);
    const e = rows[rows.length - 1]; const b = e.getBoundingClientRect(); return { x: b.left + 40, y: b.top + b.height / 2, text: e.textContent.slice(0, 30) }; })()`);
  pressX = pt.x; pressY = pt.y; dragY = 20; console.log("selection start", JSON.stringify(pt));
}
await mouse("mouseMoved", pressX, pressY);
await phase("press"); await mouse("mousePressed", pressX, pressY, 1); await sleep(150);
await phase("drag");
for (let i = 1; i <= 10; i++) { await mouse("mouseMoved", pressX, pressY + ((dragY - pressY) * i) / 10, 1); await sleep(60); }
await phase("hold"); await sleep(1500);
await phase("release-away"); await mouse("mouseReleased", pressX, dragY, 0);
await phase("after-release"); await sleep(2500);
const afterAway: any = await geo();
let resumed = "";
if (scenario === "scrollbar-stream" || scenario === "scrollbar-idle") {
  // Press the thumb again and drag it to the very bottom: following must resume on release.
  g = await geo(); const t = thumb(); const y0 = t.y; await mouse("mouseMoved", pressX, y0);
  await phase("press2"); await mouse("mousePressed", pressX, y0, 1);
  for (let i = 1; i <= 12; i++) { await mouse("mouseMoved", pressX, y0 + ((g.bottom + 40 - y0) * i) / 12, 1); await sleep(50); }
  await phase("hold2"); await sleep(600);
  await phase("release-bottom"); await mouse("mouseReleased", pressX, g.bottom + 40, 0);
  await phase("after-bottom"); await sleep(stream ? 2500 : 1200);
}
console.log("events", JSON.stringify(await a.eval(`window.__ev`)));
const samples: any[] = await a.eval(`window.__s`);
await Bun.write(`/tmp/ev10/out/press-${scenario}-${process.argv[3] ?? "new"}.json`, JSON.stringify(samples));
const writes: any[] = await a.eval(`window.__w`);
const wc = (p: string, kind: string) => writes.filter((w) => w[1] === p && w[0] === kind).length;
const by: Record<string, any[]> = {};
for (const s of samples) (by[s[1]] ??= []).push(s);
const out: string[] = [`scenario ${scenario} (${process.argv[3] ?? "new"})`];
for (const [p, rows] of Object.entries(by)) {
  const st = rows.map((r) => r[2]), gap = rows.map((r) => r[4]);
  let up = 0, down = 0;
  for (let i = 1; i < st.length; i++) { const d = st[i] - st[i - 1]; if (d > 2) up += d; if (d < -2) down -= d; }
  out.push(`  ${p.padEnd(15)} frames ${String(rows.length).padStart(4)}  scrollTop ${Math.min(...st)}..${Math.max(...st)}  gap ${Math.min(...gap)}..${Math.max(...gap)}  scrollTop +${up}px -${down}px  writes: hook ${wc(p, "hook")} virtualizer ${wc(p, "virtualizer")}`);
}
console.log(out.join("\n"));
await Bun.write(`/tmp/ev10/out/press-${scenario}-${process.argv[3] ?? "new"}.txt`, out.join("\n") + "\n");
await a.close();
