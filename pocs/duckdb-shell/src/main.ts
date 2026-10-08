// DuckDB web-shell POC: one AsyncDuckDB shared by the app and the upstream shell.
import "xterm/css/xterm.css";
import * as duckdb from "@duckdb/duckdb-wasm";
import * as shell from "@duckdb/duckdb-wasm-shell";
import { Terminal } from "xterm";

// Static assets: Vite `?url` imports emit these files into dist/assets with
// hashed names and give us their URLs. No CDN, no backend.
import mvpWasm from "@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url";
import mvpWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url";
import ehWasm from "@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url";
import ehWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url";
import shellWasm from "@duckdb/duckdb-wasm-shell/dist/shell_bg.wasm?url";

// TEST HOOK ONLY: record xterm Terminal instances the shell creates, so the
// Playwright driver can read the real terminal buffer. Does not alter output.
const terms: Terminal[] = [];
const origOpen = Terminal.prototype.open;
Terminal.prototype.open = function (this: Terminal, el: HTMLElement) {
  terms.push(this);
  return origOpen.call(this, el);
};

const BUNDLES: duckdb.DuckDBBundles = {
  mvp: { mainModule: mvpWasm, mainWorker: mvpWorker },
  eh: { mainModule: ehWasm, mainWorker: ehWorker },
};

const SEED = `
CREATE TABLE IF NOT EXISTS events(id INTEGER, kind VARCHAR, ts TIMESTAMP);
DELETE FROM events;
INSERT INTO events VALUES
 (1, 'signup',   TIMESTAMP '2024-01-01 09:00:00'),
 (2, 'login',    TIMESTAMP '2024-01-01 09:05:00'),
 (3, 'purchase', TIMESTAMP '2024-01-02 12:30:00'),
 (4, 'login',    TIMESTAMP '2024-01-03 08:15:00'),
 (5, 'logout',   TIMESTAMP '2024-01-03 18:45:00');`;

let db: duckdb.AsyncDuckDB | null = null;
let worker: Worker | null = null;
let appConn: duckdb.AsyncDuckDBConnection | null = null;
let bundleName = "";
const status = document.getElementById("status")!;

async function initDb(opts: { path?: string; seed?: boolean } = {}) {
  const bundle = await duckdb.selectBundle(BUNDLES);
  bundleName = bundle.mainModule === ehWasm ? "eh" : bundle.mainModule === mvpWasm ? "mvp" : "other";
  worker = new Worker(bundle.mainWorker!);
  db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  if (opts.path) {
    await db.open({ path: opts.path, accessMode: duckdb.DuckDBAccessMode.READ_WRITE });
  }
  appConn = await db.connect();
  if (new URLSearchParams(location.search).get("ext") === "local") {
    // Global setting: also applies to the shell's own connection.
    await appConn.query(`SET custom_extension_repository = '${location.origin}/duckdb-extensions'`);
  }
  if (opts.seed !== false) await appConn.query(SEED);
  status.textContent = `duckdb ${await db.getVersion()} bundle=${bundleName} crossOriginIsolated=${crossOriginIsolated} path=${opts.path ?? ":memory:"}`;
  return { bundle: bundleName, version: await db.getVersion(), crossOriginIsolated };
}

async function mountShell(id: string) {
  const container = document.createElement("div");
  container.className = "shell";
  container.id = id;
  document.getElementById("shells")!.appendChild(container);
  const before = terms.length;
  await shell.embed({
    shellModule: shellWasm,
    container: container as HTMLDivElement,
    resolveDatabase: async () => db!,
    backgroundColor: "#1e1e1e",
    fontFamily: "monospace",
  });
  return { termIndex: before, terms: terms.length };
}

function unmountShell(id: string) {
  document.getElementById(id)?.remove();
}

// JSON-safe conversion of Arrow rows (BigInt -> string) for the test driver.
function jsonSafe(v: unknown): unknown {
  return JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? `${x}n` : x)));
}

async function appQuery(sql: string) {
  const t = await appConn!.query(sql);
  return jsonSafe(t.toArray().map((r: any) => r.toJSON()));
}

// Arrow value probe for step 5: return typeof/String() per column.
async function appProbe(sql: string) {
  const t = await appConn!.query(sql);
  const row: any = t.toArray()[0];
  const out: Record<string, unknown> = {};
  for (const f of t.schema.fields) {
    const v = row[f.name];
    let json: string;
    try { json = JSON.stringify(v); } catch (e) { json = `THROWS: ${(e as Error).message}`; }
    out[f.name] = {
      arrowType: String(f.type),
      typeof: typeof v,
      ctor: v?.constructor?.name ?? null,
      string: String(v),
      json,
      toJSON: v && typeof v.toJSON === "function" ? safe(() => JSON.stringify(v.toJSON(), (_k, x) => typeof x === "bigint" ? `${x}n` : x)) : null,
      toArray: v && typeof v.toArray === "function" ? safe(() => String(Array.from(v.toArray()))) : null,
    };
  }
  let rowJson: string;
  try { rowJson = JSON.stringify(row.toJSON()); } catch (e) { rowJson = `THROWS: ${(e as Error).message}`; }
  return { cols: out, rowJson };
}
function safe(f: () => string) { try { return f(); } catch (e) { return `THROWS: ${(e as Error).message}`; } }

async function terminateDb() {
  try { await appConn?.close(); } catch { /* ignore */ }
  await db?.terminate();
  appConn = null; db = null; worker = null;
}

function termText(i: number) {
  const t = terms[i];
  const b = t.buffer.active;
  const lines: string[] = [];
  for (let y = 0; y < b.length; y++) lines.push(b.getLine(y)!.translateToString(true));
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}

function termFocus(i: number) { terms[i].focus(); }

(window as any).poc = { initDb, mountShell, unmountShell, appQuery, appProbe, terminateDb, termText, termFocus, terms, get db() { return db; } };

const params = new URLSearchParams(location.search);
if (params.has("manual")) {
  (window as any).pocReady = true;
} else {
  const path = params.get("path") ?? undefined;
  const seed = params.get("seed") !== "0";
  initDb({ path, seed })
    .then(() => mountShell("shell-1"))
    .then(() => { (window as any).pocReady = true; })
    .catch((e) => { status.textContent = "ERROR " + e; (window as any).pocError = String(e?.stack ?? e); });
}
