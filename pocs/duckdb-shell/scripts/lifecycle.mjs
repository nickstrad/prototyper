// Step 4: disposal, leaks, re-mount, double mount.
import { writeFileSync } from "node:fs";
import { launch, open, run, text, settle } from "./lib.mjs";
const { browser, page, logs } = await launch();
const cdp = await page.context().newCDPSession(page);
await cdp.send("Performance.enable");
const out = [];
const log = (s) => { out.push(s); console.log(s); };
const metrics = async () => {
  await cdp.send("HeapProfiler.collectGarbage");
  const m = Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((x) => [x.name, x.value]));
  return { workers: page.workers().length, jsHeapMB: +(m.JSHeapUsedSize / 1e6).toFixed(1), domNodes: m.Nodes, listeners: m.JSEventListeners, canvases: await page.evaluate(() => document.querySelectorAll("canvas").length) };
};
const winListeners = async () => {
  const { result } = await cdp.send("Runtime.evaluate", { expression: "window" });
  const { listeners } = await cdp.send("DOMDebugger.getEventListeners", { objectId: result.objectId });
  const { result: d } = await cdp.send("Runtime.evaluate", { expression: "document" });
  const { listeners: dl } = await cdp.send("DOMDebugger.getEventListeners", { objectId: d.objectId });
  return { window: listeners.map((l) => l.type).sort().join(","), document: dl.map((l) => l.type).sort().join(",") };
};

await open(page, "?manual");
log(`baseline (no db, no shell): ${JSON.stringify(await metrics())} ${JSON.stringify(await winListeners())}`);
await page.evaluate(async () => { await window.poc.initDb(); await window.poc.mountShell("shell-1"); });
await settle(page, 0);
log(`mounted #1: ${JSON.stringify(await metrics())} ${JSON.stringify(await winListeners())}`);
log(`shell#1 works:\n${await run(page, "SELECT count(*) FROM events;", 0)}`);

// --- Dispose: no upstream shutdown API exists (the package exports only `embed`).
await page.evaluate(async () => { window.poc.unmountShell("shell-1"); await window.poc.terminateDb(); });
await page.waitForTimeout(500);
log(`after unmount + db.terminate(): ${JSON.stringify(await metrics())} ${JSON.stringify(await winListeners())}`);
log(`old Terminal instance still referenced by the shell wasm? term[0].element.isConnected=${await page.evaluate(() => window.poc.terms[0].element?.isConnected)}`);

// --- Re-mount with a fresh db
await page.evaluate(async () => { await window.poc.initDb(); await window.poc.mountShell("shell-2"); });
await settle(page, 1);
log(`re-mounted (term index 1): ${JSON.stringify(await metrics())}`);
log(`re-mounted terminal text:\n${await text(page, 1)}`);
log(`shell after remount:\n${await run(page, "SELECT count(*) FROM events;", 1)}`);

// --- 5 cycles to look for growth
for (let k = 0; k < 5; k++) {
  await page.evaluate(async (k) => {
    window.poc.unmountShell(document.querySelector(".shell").id);
    await window.poc.terminateDb();
    await window.poc.initDb();
    await window.poc.mountShell("cyc-" + k);
  }, k);
  await settle(page, 2 + k, 400);
}
log(`after 5 more unmount/terminate/init/mount cycles: ${JSON.stringify(await metrics())} ${JSON.stringify(await winListeners())} totalTerminalsCreated=${await page.evaluate(() => window.poc.terms.length)}`);
const last = await page.evaluate(() => window.poc.terms.length - 1);
log(`latest shell works:\n${await run(page, "SELECT count(*) FROM events;", last)}`);

// --- Double mount: second shell on the same db while the first is still in the DOM
await page.evaluate(async () => { await window.poc.mountShell("tab-B"); });
const a = last, b = last + 1;
await settle(page, b);
log(`double mount: tab-A=term${a}, tab-B=term${b}; ${JSON.stringify(await metrics())}`);
log(`tab-B initial text:\n${await text(page, b)}`);
const aBefore = await text(page, a), bBefore = await text(page, b);
await page.evaluate((a) => window.poc.termFocus(a), a);
await page.keyboard.type("SELECT 'typed-in-A' AS who;", { delay: 5 }); await page.keyboard.press("Enter");
await page.waitForTimeout(1500);
log(`after typing in tab-A — tab-A delta:\n${(await text(page, a)).slice(aBefore.length)}\n--- tab-B delta:\n${(await text(page, b)).slice(bBefore.length)}`);
const a2 = await text(page, a), b2 = await text(page, b);
await page.evaluate((b) => window.poc.termFocus(b), b);
await page.keyboard.type("SELECT 'typed-in-B' AS who;", { delay: 5 }); await page.keyboard.press("Enter");
await page.waitForTimeout(1500);
log(`after typing in tab-B — tab-A delta:\n${(await text(page, a)).slice(a2.length)}\n--- tab-B delta:\n${(await text(page, b)).slice(b2.length)}`);

// --- Shell + app after db.terminate() while shell still mounted
const a3 = await text(page, b);
await page.evaluate(async () => { await window.poc.terminateDb(); });
await page.evaluate((b) => window.poc.termFocus(b), b);
await page.keyboard.type("SELECT 1;", { delay: 5 }); await page.keyboard.press("Enter");
await page.waitForTimeout(2000);
log(`typing in a still-mounted shell after db.terminate():\n${(await text(page, b)).slice(a3.length)}`);
log(`final: ${JSON.stringify(await metrics())}`);
log("console (filtered):\n" + logs.filter((l) => !l.includes("GL Driver") && !l.includes("[vite]")).join("\n"));
writeFileSync(new URL("../evidence/30-lifecycle.txt", import.meta.url), out.join("\n\n") + "\n");
await browser.close();
