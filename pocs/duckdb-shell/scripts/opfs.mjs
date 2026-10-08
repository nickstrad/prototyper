// Step 7: opfs:// persistence with @duckdb/duckdb-wasm@1.32.0, shared by app + shell.
import { writeFileSync } from "node:fs";
import { launch, open, run, text, BASE } from "./lib.mjs";
const { browser, context, page, logs } = await launch();
const out = [];
const log = (s) => { out.push(s); console.log(s); };
const app = (p, sql) => p.evaluate((sql) => window.poc.appQuery(sql).catch((e) => "ERROR " + e.message), sql);
const PATH = "opfs://poc.duckdb";

// Clean slate in this (fresh, ephemeral) browser profile.
await page.goto(BASE + "?manual");
log("OPFS entries before: " + JSON.stringify(await page.evaluate(async () => { const r = await navigator.storage.getDirectory(); const n = []; for await (const k of r.keys()) n.push(k); return n; })));

try { await open(page, `?path=${PATH}`); log("load 1 (seeded): " + (await page.textContent("#status"))); }
catch (e) { log("load 1 FAILED: " + e.message); }
log("banner:\n" + (await text(page)));
log("app insert: " + JSON.stringify(await app(page, "INSERT INTO events VALUES (100, 'opfs_app', NULL)")));
log(await run(page, "INSERT INTO events VALUES (101, 'opfs_shell', NULL);\nSELECT database_name, path, readonly FROM duckdb_databases() WHERE NOT internal;\nCHECKPOINT;"));
log("OPFS entries after checkpoint: " + JSON.stringify(await page.evaluate(async () => { const r = await navigator.storage.getDirectory(); const n = []; for await (const [k, h] of r.entries()) n.push(k + (h.kind === "file" ? ":" + (await h.getFile()).size : "/")); return n; })));

// Second tab in the same origin while the first holds the file.
const tab2 = await context.newPage();
const t2logs = []; tab2.on("console", (m) => t2logs.push(m.text())); tab2.on("pageerror", (e) => t2logs.push("pageerror " + e.message));
try { await open(tab2, `?path=${PATH}&seed=0`); log("second tab opened same OPFS file: " + (await tab2.textContent("#status")) + " count=" + JSON.stringify(await app(tab2, "SELECT count(*)::INTEGER c FROM events"))); }
catch (e) { log("second tab FAILED: " + e.message.split("\n")[0] + "\n  pocError: " + (await tab2.evaluate(() => window.pocError)) + "\n  status: " + (await tab2.textContent("#status"))); }
await tab2.close();

// Reload: navigate to the same OPFS path without seeding, read back.
await page.goto(BASE + `?path=${PATH}&seed=0`);
await page.waitForFunction(() => window.pocReady || window.pocError, null, { timeout: 120000 });
log("after reload status: " + (await page.textContent("#status")) + " err=" + (await page.evaluate(() => window.pocError)));
log("app read back: " + JSON.stringify(await app(page, "SELECT id, kind FROM events ORDER BY id")));
log("shell read back:\n" + (await run(page, "SELECT count(*) FROM events;")));

// Without CHECKPOINT: insert, reload, check (WAL replay?)
log("app insert 102 (no checkpoint): " + JSON.stringify(await app(page, "INSERT INTO events VALUES (102, 'no_checkpoint', NULL)")));
await page.goto(BASE + `?path=${PATH}&seed=0`);
await page.waitForFunction(() => window.pocReady || window.pocError, null, { timeout: 120000 });
log("after reload w/o checkpoint: " + JSON.stringify(await app(page, "SELECT id, kind FROM events WHERE id >= 100 ORDER BY id")) + " err=" + (await page.evaluate(() => window.pocError)));
log("console (filtered):\n" + logs.filter((l) => !l.includes("GL Driver") && !l.includes("[vite]")).join("\n"));
log("tab2 console:\n" + t2logs.filter((l) => !l.includes("GL Driver") && !l.includes("[vite]")).join("\n"));
writeFileSync(new URL("../evidence/60-opfs.txt", import.meta.url), out.join("\n\n") + "\n");
await browser.close();
