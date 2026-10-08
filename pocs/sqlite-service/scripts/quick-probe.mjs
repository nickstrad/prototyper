// Quick smoke: probe + memory + sahpool through a given URL (used for the Vite dev server).
import { chromium } from "playwright";
import { homedir } from "node:os";
const url = process.argv[2];
const browser = await chromium.launch({ executablePath: `${homedir()}/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing` });
const page = await browser.newPage();
const logs = [];
page.on("console", (m) => logs.push(`${m.type()}: ${m.text()}`));
page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`));
await page.goto(url);
await page.waitForSelector("body[data-ready='1']", { timeout: 15000 });
const r = await page.evaluate(async () => {
  try {
    const w = await window.poc.spawnWorker();
    const out = { probe: await w.call("probe") };
    out.memory = await w.call("open", { vfs: "memory" });
    out.select = await w.call("exec", { sql: "SELECT sqlite_version() AS v, 9007199254740993 AS big" });
    out.sahpool = await w.call("open", { vfs: "opfs-sahpool", filename: "/dev.sqlite3" });
    return out;
  } catch (e) {
    return { error: `${e.name}: ${e.message}` };
  }
});
console.log(JSON.stringify({ url, result: r, logs }, null, 1));
await browser.close();
