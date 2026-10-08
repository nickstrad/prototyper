// Playwright probe of the built app. Usage: node scripts/browser-probe.mjs <plainUrl> <coiUrl> <outJson>
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";

const [plainUrl = "http://127.0.0.1:4173/", coiUrl = "http://127.0.0.1:4174/", outFile = "evidence/browser-probe.json"] = process.argv.slice(2);
const executablePath = `${homedir()}/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const browser = await chromium.launch({ executablePath });
const report = { browserVersion: browser.version(), executablePath, plainUrl, coiUrl, steps: {} };
const consoleLog = [];
const step = async (name, fn) => {
  try {
    report.steps[name] = await fn();
  } catch (e) {
    report.steps[name] = { harnessError: String(e) };
  }
  console.log(`== ${name}\n${JSON.stringify(report.steps[name], null, 1).slice(0, 1500)}`);
};

const openPage = async (ctx, url, tag) => {
  const page = await ctx.newPage();
  page.on("console", (m) => consoleLog.push(`[${tag}] ${m.type()}: ${m.text()}`));
  page.on("pageerror", (e) => consoleLog.push(`[${tag}] pageerror: ${e.message}`));
  await page.goto(url);
  await page.waitForSelector("body[data-ready='1']");
  return page;
};

// Runs inside the page: spawn a worker (kept on window by key), call ops, return results or errors.
const rpc = (page, key, calls) =>
  page.evaluate(async ({ key, calls }) => {
    const w = (window.__w ??= {});
    w[key] ??= await window.poc.spawnWorker();
    const out = [];
    for (const [op, args] of calls) {
      try {
        let a = args;
        if (a && a.bytesFrom) a = { ...a, bytes: window.__bytes[a.bytesFrom] };
        const r = await w[key].call(op, a);
        if (r instanceof Uint8Array) {
          (window.__bytes ??= {})[op + out.length] = r;
          out.push({ op, ok: true, bytes: r.byteLength, savedAs: op + out.length, header: String.fromCharCode(...r.subarray(0, 15)) });
        } else out.push({ op, ok: true, result: r });
      } catch (e) {
        out.push({ op, ok: false, error: { name: e.name, message: e.message, info: e.info } });
      }
    }
    return out;
  }, { key, calls });

const SEED = `CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY, title TEXT NOT NULL, completed INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
INSERT INTO tasks (title, created_at) VALUES ('seed', '2026-01-01');`;
const VALUES = `SELECT 42 AS i, 9007199254740993 AS big, x'00ff10' AS b, 1.5 AS r, NULL AS n, 1=1 AS bool, 'héllo' AS t`;

for (const [mode, url] of [["plain", plainUrl], ["coi", coiUrl]]) {
  const ctx = await browser.newContext();
  const page = await openPage(ctx, url, mode);
  await step(`${mode}: probe`, async () => ({ pageCrossOriginIsolated: await page.evaluate(() => self.crossOriginIsolated), worker: await rpc(page, "p", [["probe"]]) }));
  await step(`${mode}: memory`, () => rpc(page, "m", [["open", { vfs: "memory" }], ["exec", { sql: SEED }], ["exec", { sql: VALUES }], ["exec", { sql: "SELEC 1" }], ["exec", { sql: "SELECT * FROM tasks" }]]));
  for (const vfs of ["opfs-sahpool", "opfs", "opfs-wl"]) {
    const file = `/reload-${vfs}.sqlite3`;
    await step(`${mode}: ${vfs} write`, () => rpc(page, `w-${vfs}`, [["open", { vfs, filename: file, fresh: true }], ["exec", { sql: SEED }], ["exec", { sql: "SELECT count(*) FROM tasks" }], ["close"]]));
  }
  await page.evaluate(() => Object.values(window.__w ?? {}).forEach((w) => w.terminate()));
  await page.reload();
  await page.waitForSelector("body[data-ready='1']");
  for (const vfs of ["opfs-sahpool", "opfs", "opfs-wl"]) {
    const file = `/reload-${vfs}.sqlite3`;
    await step(`${mode}: ${vfs} after reload`, () => rpc(page, `r-${vfs}`, [["open", { vfs, filename: file }], ["exec", { sql: "SELECT count(*) AS n FROM tasks" }], ["close"]]));
  }
  await page.evaluate(() => Object.values(window.__w ?? {}).forEach((w) => w.terminate()));
  await page.evaluate(() => (window.__w = {}));

  // Multi-tab (two pages, same origin/context)
  await step(`${mode}: sahpool two tabs`, async () => {
    const a = await openPage(ctx, url, `${mode}-A`);
    const b = await openPage(ctx, url, `${mode}-B`);
    const r = {};
    r.A_open = await rpc(a, "s", [["open", { vfs: "opfs-sahpool", filename: "/multi.sqlite3", fresh: true }], ["exec", { sql: SEED }]]);
    r.B_install = await rpc(b, "s", [["installSahpool", {}]]);
    r.B_open = await rpc(b, "s", [["open", { vfs: "opfs-sahpool", filename: "/multi.sqlite3" }]]);
    r.A_pause = await rpc(a, "s", [["pauseSahpool"]]);
    r.B_retry_in_same_worker = await rpc(b, "s", [["installSahpool", {}], ["open", { vfs: "opfs-sahpool", filename: "/multi.sqlite3" }], ["exec", { sql: "SELECT count(*) AS n FROM tasks" }]]);
    r.B_fresh_worker_after_A_pause = await rpc(b, "s2", [["open", { vfs: "opfs-sahpool", filename: "/multi.sqlite3" }], ["exec", { sql: "INSERT INTO tasks (title, created_at) VALUES ('from B', 'now'); SELECT count(*) AS n FROM tasks" }], ["pauseSahpool"]]);
    r.A_unpause_after_B_pause = await rpc(a, "s", [["unpauseSahpool"], ["open", { vfs: "opfs-sahpool", filename: "/multi.sqlite3" }], ["exec", { sql: "SELECT title FROM tasks ORDER BY id" }]]);
    await a.close();
    await b.close();
    return r;
  });
  for (const vfs of ["opfs", "opfs-wl"]) {
    await step(`${mode}: ${vfs} two tabs`, async () => {
      const a = await openPage(ctx, url, `${mode}-A`);
      const b = await openPage(ctx, url, `${mode}-B`);
      const r = {};
      r.A = await rpc(a, "o", [["open", { vfs, filename: "/multi2.sqlite3", fresh: true }], ["exec", { sql: SEED }]]);
      r.B = await rpc(b, "o", [["open", { vfs, filename: "/multi2.sqlite3" }], ["exec", { sql: "INSERT INTO tasks (title, created_at) VALUES ('from B', 'now'); SELECT count(*) AS n FROM tasks" }]]);
      r.A_sees_B = await rpc(a, "o", [["exec", { sql: "SELECT count(*) AS n FROM tasks" }]]);
      await a.close();
      await b.close();
      return r;
    });
  }
  // Export / import
  for (const vfs of ["memory", "opfs-sahpool", ...(mode === "coi" ? ["opfs"] : [])]) {
    await step(`${mode}: export/import ${vfs}`, async () => {
      const p = await openPage(ctx, url, `${mode}-x`);
      const r = {};
      r.src = await rpc(p, "x", [["open", { vfs, filename: "/xsrc.sqlite3", fresh: true }], ["exec", { sql: SEED + "INSERT INTO tasks (title, created_at) VALUES ('second', 'now');" }], ["export"]]);
      const saved = r.src[2].savedAs;
      r.importFresh = await rpc(p, "x", [["open", { vfs, filename: "/xdst.sqlite3", fresh: true, bytesFrom: saved }], ["exec", { sql: "SELECT title FROM tasks ORDER BY id" }]]);
      r.importLive = await rpc(p, "x", [["exec", { sql: "DELETE FROM tasks" }], ["importLive", { bytesFrom: saved }], ["exec", { sql: "SELECT count(*) FROM tasks" }]]);
      r.reopenAfterLiveImport = await rpc(p, "x", [["open", { vfs, filename: "/xdst.sqlite3" }], ["exec", { sql: "SELECT count(*) FROM tasks" }]]);
      await p.close();
      return r;
    });
  }
  // Effect service in the browser over the worker driver
  for (const vfs of ["memory", "opfs-sahpool", ...(mode === "coi" ? ["opfs"] : [])]) {
    await step(`${mode}: effect service ${vfs}`, async () => {
      const p = await openPage(ctx, url, `${mode}-e`);
      const r = await p.evaluate((vfs) => window.poc.effectService(vfs, [
        "INSERT INTO tasks (title, created_at) VALUES ('browser', 'now')",
        "SELEC 1",
        "SELECT count(*) AS n FROM tasks",
      ]).then((x) => JSON.parse(JSON.stringify(x))), vfs);
      await p.close();
      return r;
    });
  }
  await ctx.close();
}
report.console = consoleLog;
writeFileSync(outFile, JSON.stringify(report, null, 2));
await browser.close();
