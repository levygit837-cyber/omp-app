import { connect } from "./cdp.mjs";
const name = process.argv[2];
const c = await connect(9342);
await c.viewport(1440, 900);
const id = await c.eval(`window.omp.session.create("/tmp/smoke12/proj/omp-app")`);
await c.eval(`sessionStorage.setItem("omp-app.sessionId", ${JSON.stringify(id)}); location.reload()`);
await c.sleep(2500);
const state = () => c.eval(`JSON.stringify({kind: document.querySelector('[data-testid=wait-band]')?.dataset.kind, label: document.querySelector('[data-testid=wait-band] header')?.textContent, buttons: [...document.querySelectorAll('[data-testid^=answer-]')].map(b=>b.textContent+(b.disabled?'(disabled)':'')), choices: [...document.querySelectorAll('[data-testid^=choice-]')].map(i=>i.dataset.testid+':'+i.checked), decisions: [...document.querySelectorAll('[data-testid=item-decision]')].map(e=>e.textContent), tab: document.querySelector('[data-testid=waiting-tab]')?.textContent, hint: [...document.querySelectorAll('[data-testid=wait-band] p')].map(p=>p.textContent).filter(t=>/esc|move/.test(t)), status: document.querySelector('[data-testid=session-status]')?.dataset.status})`);
await c.eval(`window.omp.session.prompt(${JSON.stringify(id)}, "go")`);
await c.sleep(3500);
console.log(name, "raised", await state());
await c.shot(`/tmp/smoke12/shots/${name}-1.png`);
const steps = JSON.parse(process.argv[3] ?? "[]");
for (const s of steps) {
  if (s.key) await c.key(s.key, { alt: s.alt });
  if (s.click) await c.eval(`document.querySelector('[data-testid=${s.click}]').click()`);
  if (s.type) await c.eval(`(()=>{const i=document.querySelector('${s.type[0]}');const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(i,${JSON.stringify(s.type[1])});i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await c.sleep(700);
  console.log(name, JSON.stringify(s), await state());
  if (s.shot) await c.shot(`/tmp/smoke12/shots/${name}-${s.shot}.png`);
}
c.close();
