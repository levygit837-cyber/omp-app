import { App, sleep } from "./cdp";
const PROJ = "/Users/levy/Documents/Workspace/Projects/Developer-Tools/omp-app-worktrees/10-styled-shell";
const a = await App.launch({ OMP_APP_SIDECAR_BIN: "/tmp/ev10/fake.sh", FAKE_SIDECAR: "ok", FAKE_ITEMS: "500" });
await a.openSession(PROJ);
await sleep(1500);
const st = `(() => { const t = document.querySelector('[data-testid=timeline]'); return { scrollTop: Math.round(t.scrollTop), scrollHeight: t.scrollHeight, gap: Math.round(t.scrollHeight - t.clientHeight - t.scrollTop) + 0 }; })()`;
const key = async (k: string, code: string, vk: number, modifiers: number) => {
  await a.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: k, code, windowsVirtualKeyCode: vk, modifiers });
  await a.send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk, modifiers });
};
await a.eval(`document.querySelector('[data-testid=timeline]').focus()`);
console.log("500 items, open          ", JSON.stringify(await a.eval(st)));
for (const round of [1, 2, 3]) {
  await key("ArrowUp", "ArrowUp", 38, 4);
  await sleep(1200);
  console.log(`round ${round} Cmd+Up   x1       `, JSON.stringify(await a.eval(st)));
  await key("ArrowDown", "ArrowDown", 40, 4);
  await sleep(1200);
  console.log(`round ${round} Cmd+Down x1       `, JSON.stringify(await a.eval(st)));
}
// the same, but starting from the middle, and Home/End for comparison
await a.eval(`(() => { const t = document.querySelector('[data-testid=timeline]'); t.scrollTop = 30000; })()`);
await sleep(600);
console.log("from the middle          ", JSON.stringify(await a.eval(st)));
await key("ArrowUp", "ArrowUp", 38, 4); await sleep(1200);
console.log("middle, Cmd+Up x1        ", JSON.stringify(await a.eval(st)));
await key("End", "End", 35, 0); await sleep(1200);
console.log("End x1                   ", JSON.stringify(await a.eval(st)));
await key("Home", "Home", 36, 0); await sleep(1200);
console.log("Home x1                  ", JSON.stringify(await a.eval(st)));
await a.close();
