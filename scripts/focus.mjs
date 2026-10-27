import { connect } from "./cdp.mjs";
const mode = process.argv[2];
const c = await connect(9342);
await c.viewport(1440, 900);
const id = await c.eval(`window.omp.session.create("/tmp/smoke12/proj/omp-app")`);
await c.eval(`sessionStorage.setItem("omp-app.sessionId", ${JSON.stringify(id)}); location.reload()`);
await c.sleep(2500);
await c.eval(`window.omp.session.prompt(${JSON.stringify(id)}, "go")`);
await c.sleep(3500);
const active = () => c.eval(`document.activeElement?.id || document.activeElement?.tagName`);
console.log(mode, "before", await active(), await c.eval(`[...document.querySelectorAll('[data-testid=wait-band] p')].map(p=>p.textContent).filter(t=>/Always|cancel/.test(t)).join(' | ')`));
await c.shot(`/tmp/smoke12/shots/${mode}-v2.png`);
// An Enter inside the grace window must not answer; use a fresh request's first 300 ms is hard to hit, so test the guard in unit tests.
await c.key(mode === "ask" ? "Escape" : "Enter");
await c.sleep(700);
console.log(mode, "after", await active(), await c.eval(`document.querySelectorAll('[data-testid=wait-band]').length`));
await c.shot(`/tmp/smoke12/shots/${mode}-v2-after.png`);
c.close();
