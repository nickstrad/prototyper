// Drives web/index.html in real Chrome via Playwright and writes evidence/*.txt.
// Usage: node scripts/run-walkthrough.mjs   (starts its own Deno static servers)
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EV = path.join(ROOT, "evidence");
mkdirSync(EV, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function serve(port, coi) {
  const p = spawn("deno", ["run", "--allow-net", "--allow-read", "--allow-env", "scripts/serve.ts"], {
    cwd: ROOT, env: { ...process.env, PORT: String(port), COI: coi ? "1" : "0" }, stdio: "ignore",
  });
  return p;
}
async function waitUp(url) {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(url)).ok) return; } catch {} await sleep(100); }
  throw new Error("server not up: " + url);
}

const servers = [serve(8787, false), serve(8788, true)];
await waitUp("http://127.0.0.1:8787/web/index.html");
await waitUp("http://127.0.0.1:8788/web/index.html");
const browser = await chromium.launch({ channel: process.env.PW_CHANNEL ?? "chrome", headless: true });
const errors = [];

async function open(base, args) {
  const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
  page.on("pageerror", (e) => errors.push(e.message));
  const q = args === undefined ? "" : "?args=" + encodeURIComponent(args.join(","));
  await page.goto(base + "/web/index.html" + q);
  const info = await page.evaluate(() => poc.ready);
  return { page, info };
}
const fmtOut = (r) => r.output.join("\n");
function transcriptOf(lines) { return lines.join("\n") + "\n"; }
async function run(page, log, text, label) {
  const r = await page.evaluate((t) => poc.exec(t), text);
  log.push(`### ${label ?? "input"} (fiddle_exec ${JSON.stringify(text)})`);
  log.push(fmtOut(r));
  log.push(`[prompt after: ${JSON.stringify(r.prompt)}]`, "");
  return r;
}
const J = (v) => JSON.stringify(v, (k, x) => (typeof x === "bigint" ? `${x}n` : x instanceof Object && x.constructor?.name === "Uint8Array" ? { Uint8Array: Array.from(x) } : x), 1);

const SEED = "CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT);\nINSERT INTO t(name) VALUES('from-shell');\n";

// ---------- 1. Required walkthrough (upstream fiddle argv: -bail -safe) ----------
async function walkthrough(args, file, title) {
  const { page, info } = await open("http://127.0.0.1:8787", args);
  const log = [`# ${title}`, `# shell argv: ${JSON.stringify(args ?? ["-bail", "-safe", "/fiddle.sqlite3"])}`, `# init: ${J(info)}`, ""];
  await run(page, log, SEED, "seed via shell");
  for (const cmd of [".help", ".tables", ".schema", ".mode table", ".headers on", "SELECT * FROM t;",
    ".mode csv", "SELECT * FROM t;", ".mode json", "SELECT * FROM t;"]) await run(page, log, cmd + "\n");
  await run(page, log, ".mode table\n", "back to table mode");
  await run(page, log, "SELECT id,\n       name\n  FROM t\n WHERE id >= 1\n ORDER BY id;\n", "multiline statement, one submission");
  await run(page, log, "SELECT id\n", "multiline split across submissions: part 1 (no semicolon)");
  await run(page, log, "  FROM t;\n", "multiline split across submissions: part 2");
  await run(page, log, "INSERT INTO t(name) VALUES('semi;colon');\nSELECT * FROM t WHERE name = 'semi;colon';\n", "string containing a semicolon");
  await run(page, log, "SELECT * FROM no_such_table;\n", "error");
  await run(page, log, "SELECT count(*) AS n FROM t;\n", "valid command after error (separate submission)");
  await run(page, log, "SELECT * FROM no_such_table;\nSELECT 'after-error-same-submission' AS x;\n", "error then valid in the SAME submission");
  await run(page, log, ".headers off\n");
  await run(page, log, "SELECT * FROM t;\n", "after .headers off (table mode)");
  await run(page, log, ".nosuchcommand\n", "unknown dot-command");
  writeFileSync(path.join(EV, file), transcriptOf(log));
  await page.close();
}
await walkthrough(undefined, "02-walkthrough-upstream-argv.txt", "Required command walkthrough, upstream Fiddle argv");
await walkthrough(["/fiddle.sqlite3"], "03-walkthrough-no-bail-no-safe.txt", "Same walkthrough, argv without -bail/-safe");

// ---------- 2. File / unsupported commands in both modes ----------
for (const [args, file] of [[undefined, "05-file-commands-safe.txt"], [["/fiddle.sqlite3"], "05-file-commands-nosafe.txt"]]) {
  const { page } = await open("http://127.0.0.1:8787", args);
  const log = [`# file-ish / host commands, argv ${JSON.stringify(args ?? ["-bail", "-safe", "/fiddle.sqlite3"])}`, ""];
  await run(page, log, SEED);
  for (const c of [".databases", ".dbinfo", ".vfsname", ".vfsinfo", ".vfslist", ".dump", ".save /saved.db", ".backup /backup.db",
    ".output /out.txt", ".once /once.txt", ".read /saved.db", ".import /x.csv t", ".open /other.db", ".tables",
    ".open /fiddle.sqlite3", ".tables", ".restore /saved.db", ".shell ls", ".system ls", ".load foo", ".excel", ".www", ".cd /",
    ".nonce x", ".timer on", "SELECT 1;", ".timer off", ".quit", "SELECT 'still alive after .quit';", ".exit", "SELECT 'still alive after .exit';"]) {
    await run(page, log, c + "\n");
  }
  writeFileSync(path.join(EV, file), transcriptOf(log));
  await page.close();
}

// ---------- 3. Bridge test (same worker, same WASM instance, same sqlite3* handle) ----------
{
  const { page, info } = await open("http://127.0.0.1:8787");
  const log = ["# Narrow native bridge: shell and app on the SAME sqlite3* (fiddle_db_handle)", `# init: ${J(info)}`, ""];
  const step = async (label, fn) => { const v = await page.evaluate(fn).catch((e) => ({ ERROR: e.message.split("\n")[0] })); log.push(`## ${label}`, J(v), ""); return v; };
  await step("handle before any shell input", () => poc.info());
  await run(page, log, SEED, "shell: CREATE + INSERT 'from-shell'");
  await step("handle after shell input + handle-changed events", async () => ({ info: await poc.info(), events: poc.handleEvents }));
  await step("app (raw exports prepare_v2/step/column_*): SELECT * FROM t", () => poc.query("SELECT * FROM t"));
  await step("app (raw sqlite3_exec): INSERT 'from-app'", () => poc.cexec("INSERT INTO t(name) VALUES('from-app')"));
  await run(page, log, ".mode table\n");
  await run(page, log, "SELECT * FROM t;\n", "shell sees app row?");
  await step("enable update hook (change notifications)", () => poc.hook(true));
  await run(page, log, "INSERT INTO t(name) VALUES('shell-2'); UPDATE t SET name='shell-2b' WHERE name='shell-2';\n", "shell: INSERT + UPDATE");
  await step("change events received from update hook", () => poc.changes.splice(0));
  await step("UPSTREAM BUG probe: capi.sqlite3_bind_text(pStmt,1,'x',...) in this trunk build", () => poc.probeBindText());
  await step("app sees shell-2b? (bound param)", () => poc.query("SELECT id, name FROM t WHERE name = ?", ["shell-2b"]));
  await run(page, log, ".mode json\n", "shell switches to json mode");
  await step("app query unaffected by shell .mode json", () => poc.query("SELECT count(*) AS n, max(id) AS max_id FROM t"));
  await run(page, log, "SELECT * FROM t;\n", "shell still json after app query");
  await step("types round-trip", () => poc.query("SELECT 9007199254740993 AS big, -42 AS small, 1.5 AS real, NULL AS nul, x'00ff10' AS blb, 'héllo' AS txt"));
  await step("oo1.DB.wrapHandle path (bundled JS API, non-owning)", () => poc.query("SELECT * FROM t ORDER BY id", [], "oo1"));
  await step("multi-statement app call + changes", () => poc.query("INSERT INTO t(name) VALUES('a1'),('a2'); DELETE FROM t WHERE name='a1'; SELECT count(*) AS n FROM t"));
  await step("app error is structured, not shell text", () => poc.query("SELECT * FROM nope").catch((e) => ({ error: e.message })));
  // transaction semantics: one connection, no isolation
  await run(page, log, "BEGIN; INSERT INTO t(name) VALUES('uncommitted');\n", "shell: BEGIN + INSERT (no COMMIT)");
  await step("app sees uncommitted shell row (same connection) + autocommit flag", () => poc.query("SELECT name FROM t WHERE name='uncommitted'"));
  await run(page, log, "ROLLBACK;\n");
  await step("after shell ROLLBACK", () => poc.query("SELECT count(*) AS n FROM t WHERE name='uncommitted'"));
  // export / reset / import
  const exp = await step("export (sqlite3_js_db_export on shell handle)", async () => { const r = await poc.export(); window.__exp = r.bytes;
    return { filename: r.filename, size: r.bytes.length, header: new TextDecoder().decode(r.bytes.slice(0, 15)) }; });
  await step("reset (fiddle_reset_db)", () => poc.reset());
  await run(page, log, ".tables\n", "shell after reset");
  await step("app after reset", () => poc.query("SELECT name FROM sqlite_schema"));
  await step("import via sqlite3_deserialize into SAME handle", () => poc.import(window.__exp, "deserialize"));
  await run(page, log, ".mode table\n");
  await run(page, log, "SELECT * FROM t;\n", "shell after deserialize-import");
  await step("app after deserialize-import + handle events", async () => ({ q: await poc.query("SELECT count(*) n FROM t"), info: await poc.info(), events: poc.handleEvents }));
  await run(page, log, "INSERT INTO t(name) VALUES('post-import-shell');\n", "shell write after deserialize (MEMDB)");
  await step("app sees it", () => poc.query("SELECT name FROM t ORDER BY id DESC LIMIT 1"));
  await run(page, log, ".open :memory:\n", "shell .open :memory: (replaces the connection)");
  await step("handle after .open :memory: (app follows fiddle_db_handle)", async () => ({ info: await poc.info(), events: poc.handleEvents, tables: await poc.query("SELECT name FROM sqlite_schema") }));
  await step("update hook re-installed on new handle? insert via app", async () => { await poc.query("CREATE TABLE z(a)"); await poc.query("INSERT INTO z VALUES(1)"); return poc.changes.splice(0); });
  writeFileSync(path.join(EV, "04-bridge.txt"), transcriptOf(log));
  await page.close();
}

// ---------- 4. Keyboard through xterm (raw vs sqlite3_complete line buffering) + screenshots ----------
for (const mode of ["raw", "complete"]) {
  const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://127.0.0.1:8787/web/index.html?linebuf=" + mode);
  await page.evaluate(() => poc.ready);
  await page.click("#term");
  const lines = [SEED.split("\n")[0], SEED.split("\n")[1], ".mode box", "SELECT * FROM t;", ".tables",
    "SELECT 1", ";", "SELECT id,", "       name", "  FROM t;", "INSERT INTO t(name) VALUES('a;", "b');",
    "SELECT name FROM t WHERE id = 2;", "SELECT * FROM nope;", "SELECT 'ok after error';"];
  for (const line of lines) { await page.keyboard.type(line); await page.keyboard.press("Enter"); await page.evaluate(() => poc.keysIdle()); }
  await sleep(200);
  writeFileSync(path.join(EV, `07-xterm-keyboard-${mode}.txt`), `# typed via Playwright keyboard into xterm, linebuf=${mode}\n` + (await page.evaluate(() => poc.screen())) + "\n");
  await page.screenshot({ path: path.join(EV, `07-xterm-keyboard-${mode}.png`) });
  await page.close();
}

// ---------- 5. Cross-origin isolated mode: VFS list, OPFS, cancellation ----------
{
  const { page, info } = await open("http://127.0.0.1:8788");
  const log = ["# Served WITH COOP/COEP (COI=1)", `# init: ${J(info)}`, ""];
  await run(page, log, SEED);
  log.push("## enableCancel", J(await page.evaluate(() => poc.enableCancel())), "");
  const t0 = Date.now();
  const r = await page.evaluate(async () => {
    const p = poc.exec("WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c) SELECT count(*) FROM c;\n");
    await new Promise((r) => setTimeout(r, 500)); poc.cancel(); return p;
  });
  log.push("## infinite recursive CTE, poc.cancel() after 500ms (progress handler + SAB)", fmtOut(r), `elapsed ms: ${Date.now() - t0}`, "");
  await run(page, log, "SELECT 'alive after cancel';\n");
  await run(page, log, ".open file:/opfs-test.db?vfs=opfs\n", "try OPFS vfs");
  await page.close();
  const { page: p2 } = await open("http://127.0.0.1:8788", ["/fiddle.sqlite3"]);
  log.push("# --- new page, COI, argv without -safe ---", "");
  await run(p2, log, ".open file:/opfs-test.db?vfs=opfs\n", "OPFS open, no -safe");
  await run(p2, log, "CREATE TABLE IF NOT EXISTS p(x); INSERT INTO p VALUES(datetime('now')); SELECT count(*) AS rows_in_opfs_table FROM p;\n");
  await run(p2, log, ".vfsname\n");
  log.push("## app bridge on the OPFS handle", J(await p2.evaluate(() => poc.query("SELECT count(*) AS n FROM p"))), "");
  await p2.reload(); await p2.evaluate(() => poc.ready); const p3 = p2;
  log.push("# --- page.reload() in the same browser context (new worker + new WASM instance): is OPFS data persistent? ---", "");
  await run(p3, log, ".open file:/opfs-test.db?vfs=opfs\n");
  await run(p3, log, "SELECT count(*) AS rows_after_reload FROM p;\n");
  await p3.close();
  writeFileSync(path.join(EV, "08-coi-cancel-opfs.txt"), transcriptOf(log));
}

// ---------- 6. Main-thread (no Worker) probe ----------
{
  const page = await browser.newPage();
  page.on("pageerror", (e) => errors.push("mainthread: " + e.message));
  await page.goto("http://127.0.0.1:8787/web/mainthread.html");
  const r = await page.evaluate(() => window.probe).catch((e) => ({ ERROR: e.message }));
  writeFileSync(path.join(EV, "09-main-thread.txt"), "# fiddle-module.js loaded via <script> on the main thread\n" + J(r) + "\n");
  await page.close();
}

writeFileSync(path.join(EV, "00-page-errors.txt"), errors.join("\n") + "\n");
await browser.close();
servers.forEach((s) => s.kill());
console.log("done; page errors:", errors.length);
