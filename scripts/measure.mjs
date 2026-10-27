import { connect } from "./cdp.mjs";
const c = await connect(9342);
console.log(await c.eval(`(()=>{const b=document.querySelector('[data-testid=wait-band]');const p=b.querySelector('p');const s=p.querySelector('span:last-child');const f=b.querySelector('fieldset');const r=e=>{const x=e.getBoundingClientRect();return [Math.round(x.top),Math.round(x.bottom),Math.round(x.height)]};return JSON.stringify({band:r(b),p:r(p),span:r(s),fieldset:r(f),pcls:p.className,scroll:[b.scrollHeight,b.clientHeight],lh:getComputedStyle(s).lineHeight,pdisp:getComputedStyle(p).display, kids:[...b.children].map(k=>k.tagName+':'+r(k))})})()`));
c.close();
