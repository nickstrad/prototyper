import { chromium } from "playwright";
import { homedir } from "node:os";
const url = process.argv[2];
const browser = await chromium.launch({ executablePath: `${homedir()}/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing` });
const page = await browser.newPage();
const logs = [];
page.on("console", (m) => logs.push(`${m.type()}: ${m.text()}`));
await page.goto(url);
await page.waitForSelector("body[data-ready='1']", { timeout: 15000 });
const r = await page.evaluate(async () => {
  const w = await window.poc.spawnWorker();
  const p = await w.call("probe");
  try { return { coi: self.crossOriginIsolated, vfsFind: p.vfsFind, opfs: await w.call("open", { vfs: "opfs", filename: "/devcoi.sqlite3" }), wl: await w.call("open", { vfs: "opfs-wl", filename: "/devcoi2.sqlite3" }) }; }
  catch (e) { return { coi: self.crossOriginIsolated, vfsFind: p.vfsFind, error: `${e.name}: ${e.message}` }; }
});
console.log(JSON.stringify({ url, r, logs }));
await browser.close();
