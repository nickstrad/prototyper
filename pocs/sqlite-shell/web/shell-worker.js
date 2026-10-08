/*
  POC worker: loads the UNMODIFIED upstream Fiddle build (vendor/fiddle/fiddle-module.js
  + fiddle-module.wasm), runs the real sqlite3 shell main() via fiddle_main, feeds input
  via fiddle_exec, and exposes a narrow "native bridge" that runs structured queries on the
  SAME sqlite3* handle the shell has open (fiddle_db_handle), using raw WASM exports.

  Protocol (main -> worker):  {type, id, ...}
    init   {args?: string[], vendorDir?: string}
    exec   {text}                         shell input (as if typed / pasted)
    query  {sql, params?, via?: 'raw'|'oo1'}  structured access -> {columns, rows, changes, ...}
    reset | export | import {bytes, mode:'deserialize'|'shell-open'} | info | hook {on}
  Protocol (worker -> main):
    {type:'out', stream:'stdout'|'stderr', text}   one emscripten line per message
    {type:'ready', info}  {type:'reply', id, ok, value|error}  {type:'change', ...}
    {type:'handle-changed', from, to}
*/
"use strict";
let sqlite3, capi, wasm;
let shellStarted = false, busy = false, dead = false;
let lastHandle = 0, hookOn = false, interruptFlag = null;
const post = (m, t) => postMessage(m, t || []);
const out = (stream) => (...a) => post({ type: "out", stream, text: a.join(" ") });

const P = new URLSearchParams(self.location.search);
const vendorDir = P.get("vendor") || "../vendor/fiddle/";
importScripts(vendorDir + "fiddle-module.js");

const moduleArg = {
  print: out("stdout"),
  printErr: out("stderr"),
  locateFile: (path) => vendorDir + path,
  setStatus: () => {},
};

self.onerror = (...a) => {
  const err = a[4];
  if (err && err.name === "ExitStatus") { dead = true; out("stderr")("FATAL: shell exit()ed: " + err.message); }
};

const dbHandle = () => wasm.exports.fiddle_db_handle();
const vfsName = (schema = "main") => {
  const p = wasm.xWrap("fiddle_db_vfs", "*", ["string"])(schema);
  if (!p) return null;
  const v = new capi.sqlite3_vfs(p); const n = wasm.cstrToJs(v.$zName); v.dispose(); return n;
};
const dbFilename = () => wasm.xWrap("fiddle_db_filename", "string", ["string"])(0);
const prompt = () => wasm.xWrap("fiddle_get_prompt", "string:dealloc", [])();

function startShell(args) {
  if (shellStarted) return;
  const argv = ["sqlite3-fiddle.wasm", ...args];
  capi.sqlite3_shutdown(); // same as upstream fiddle-worker.js
  const pArgv = wasm.allocMainArgv(argv); // intentionally leaked: must outlive main()
  const rc = wasm.exports.fiddle_main(argv.length, pArgv);
  if (rc) throw new Error("fiddle_main rc=" + rc);
  shellStarted = true;
}

function checkHandle() {
  const h = dbHandle();
  if (h !== lastHandle) {
    post({ type: "handle-changed", from: String(lastHandle), to: String(h) });
    lastHandle = h;
    if (hookOn) installHook();
    if (interruptFlag) installProgress();
  }
  return h;
}

function installHook() { handlers.hook({ on: true }); }
function installProgress() {
  const pDb = dbHandle(); if (!pDb || !interruptFlag) return;
  capi.sqlite3_progress_handler(pDb, 1000, () => (Atomics.load(interruptFlag, 0) ? 1 : 0), 0);
}

// ---- Narrow native bridge: raw WASM exports on the shell's own sqlite3* ----
const td = new TextDecoder();
const SQLITE_ROW = 100, SQLITE_DONE = 101;
function rawQuery(sql, params = []) {
  const X = wasm.exports;
  const pDb = checkHandle();
  if (!pDb) throw new Error("shell has no open db");
  const before = X.sqlite3_total_changes64(pDb);
  const [pSql, nSql] = wasm.allocCString(sql, true);
  const ppStmt = wasm.alloc(wasm.ptr.size), pzTail = wasm.alloc(wasm.ptr.size);
  let columns = [], rows = [], statements = 0, changes = 0, bound = false;
  try {
    let cur = pSql; const end = pSql + nSql;
    while (cur < end) {
      wasm.pokePtr(ppStmt, 0);
      let rc = X.sqlite3_prepare_v2(pDb, cur, end - cur, ppStmt, pzTail);
      if (rc) throw new Error(`prepare rc=${rc}: ${wasm.cstrToJs(X.sqlite3_errmsg(pDb))}`);
      const pStmt = wasm.peekPtr(ppStmt);
      cur = wasm.peekPtr(pzTail);
      if (!pStmt) continue; // whitespace / comment
      statements++;
      try {
        const np = X.sqlite3_bind_parameter_count(pStmt);
        if (np && !bound) { bindAll(pStmt, params); bound = true; }
        const nCol = X.sqlite3_column_count(pStmt);
        const cols = []; for (let i = 0; i < nCol; i++) cols.push(wasm.cstrToJs(X.sqlite3_column_name(pStmt, i)));
        const rws = [];
        while ((rc = X.sqlite3_step(pStmt)) === SQLITE_ROW) {
          const r = [];
          for (let i = 0; i < nCol; i++) {
            switch (X.sqlite3_column_type(pStmt, i)) {
              case 1: { const v = X.sqlite3_column_int64(pStmt, i); // BigInt (WASM_BIGINT)
                r.push(v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v); break; }
              case 2: r.push(X.sqlite3_column_double(pStmt, i)); break;
              case 3: { const p = X.sqlite3_column_text(pStmt, i), n = X.sqlite3_column_bytes(pStmt, i);
                r.push(td.decode(wasm.heap8u().slice(p, p + n))); break; }
              case 4: { const p = X.sqlite3_column_blob(pStmt, i), n = X.sqlite3_column_bytes(pStmt, i);
                r.push(n ? wasm.heap8u().slice(p, p + n) : new Uint8Array()); break; }
              default: r.push(null);
            }
          }
          rws.push(r);
        }
        if (rc !== SQLITE_DONE) throw new Error(`step rc=${rc}: ${wasm.cstrToJs(X.sqlite3_errmsg(pDb))}`);
        if (nCol) { columns = cols; rows = rws; }
        if (!X.sqlite3_stmt_readonly(pStmt)) changes = Number(X.sqlite3_changes64(pDb));
      } finally { X.sqlite3_finalize(pStmt); }
    }
  } finally { wasm.dealloc(pSql); wasm.dealloc(ppStmt); wasm.dealloc(pzTail); }
  return {
    columns, rows, statements, changes,
    totalChangesDelta: Number(X.sqlite3_total_changes64(pDb) - before),
    lastInsertRowid: Number(X.sqlite3_last_insert_rowid(pDb)),
    autocommit: !!X.sqlite3_get_autocommit(pDb),
  };
}
function bindAll(pStmt, params) {
  params.forEach((v, i) => {
    const idx = i + 1;
    let rc;
    if (v === null || v === undefined) rc = capi.sqlite3_bind_null(pStmt, idx);
    else if (typeof v === "bigint") rc = capi.sqlite3_bind_int64(pStmt, idx, v);
    else if (typeof v === "number") rc = Number.isInteger(v) ? capi.sqlite3_bind_int64(pStmt, idx, BigInt(v)) : capi.sqlite3_bind_double(pStmt, idx, v);
    // text/blob bound through RAW exports: capi.sqlite3_bind_text in this trunk build throws
    // "ReferenceError: pMem is not defined" for JS strings (upstream bug, see evidence/04-bridge.txt).
    else if (v instanceof Uint8Array) { const p = wasm.allocFromTypedArray(v);
      rc = wasm.exports.sqlite3_bind_blob(pStmt, idx, p, v.length, capi.SQLITE_WASM_DEALLOC); }
    else { const [p, n] = wasm.allocCString(String(v), true);
      rc = wasm.exports.sqlite3_bind_text(pStmt, idx, p, n, capi.SQLITE_WASM_DEALLOC); }
    if (rc) throw new Error("bind rc=" + rc);
  });
}
// Second path: the bundled oo1 API wrapping (not owning) the shell's handle.
function oo1Query(sql, params) {
  const db = sqlite3.oo1.DB.wrapHandle(checkHandle(), false);
  try {
    const columns = [];
    const rows = db.exec({ sql, bind: params?.length ? params : undefined, rowMode: "array", returnValue: "resultRows", columnNames: columns });
    return { columns, rows, changes: db.changes() };
  } finally { db.close(); /* does not close the underlying handle: takeOwnership=false */ }
}

const handlers = {
  init(m) {
    const vfsBeforeShutdown = listVfs();
    startShell(m.args ?? ["-bail", "-safe", "/fiddle.sqlite3"]);
    lastHandle = dbHandle();
    return {
      libversion: capi.sqlite3_libversion(), sourceId: capi.sqlite3_sourceid(),
      pointerSize: wasm.ptr.size, filename: dbFilename(), vfs: vfsName(), prompt: prompt(),
      handle: String(lastHandle), crossOriginIsolated: self.crossOriginIsolated,
      sharedArrayBuffer: typeof SharedArrayBuffer !== "undefined",
      vfsBeforeShutdown, vfsList: listVfs(), opfs: !!capi.sqlite3_vfs_find("opfs"),
    };
  },
  exec(m) {
    if (dead) throw new Error("shell is dead (exit() called)");
    if (busy) throw new Error("busy");
    busy = true;
    try { wasm.xWrap("fiddle_exec", undefined, ["string"])(m.text); }
    finally { busy = false; }
    checkHandle();
    return { prompt: prompt() };
  },
  query(m) { return m.via === "oo1" ? oo1Query(m.sql, m.params) : rawQuery(m.sql, m.params); },
  reset() { wasm.exports.fiddle_reset_db(); return { handle: String(checkHandle()), filename: dbFilename() }; },
  export() {
    const bytes = capi.sqlite3_js_db_export(checkHandle());
    return { filename: dbFilename(), bytes };
  },
  import(m) {
    const bytes = new Uint8Array(m.bytes);
    if (m.mode === "shell-open") { // upstream fiddle approach: write file to MEMFS, then `.open` via the shell
      const fn = "/imported-" + Date.now() + ".sqlite3";
      bytes.set([1, 1], 18);
      moduleArg.FS.createDataFile("/", fn.slice(1), bytes, true, true);
      wasm.xWrap("fiddle_exec", undefined, ["string"])(".open " + fn);
      return { handle: String(checkHandle()), filename: dbFilename() };
    }
    // deserialize into the shell's existing connection: keeps the same sqlite3* handle
    const pDb = checkHandle();
    const p = wasm.allocFromTypedArray(bytes);
    const rc = capi.sqlite3_deserialize(pDb, "main", p, bytes.length, bytes.length,
      capi.SQLITE_DESERIALIZE_FREEONCLOSE | capi.SQLITE_DESERIALIZE_RESIZEABLE);
    if (rc) throw new Error("deserialize rc=" + rc + " " + capi.sqlite3_errmsg(pDb));
    return { handle: String(checkHandle()), filename: dbFilename(), vfs: vfsName() };
  },
  // Raw sqlite3_exec on the shell's handle (no callback): the plan's "insert via C API" path.
  cexec(m) {
    const X = wasm.exports, pDb = checkHandle();
    const pSql = wasm.allocCString(m.sql);
    const pzErr = wasm.alloc(wasm.ptr.size); wasm.pokePtr(pzErr, 0);
    try {
      const rc = X.sqlite3_exec(pDb, pSql, 0, 0, pzErr);
      const pe = wasm.peekPtr(pzErr);
      const err = pe ? wasm.cstrToJs(pe) : null; if (pe) X.sqlite3_free(pe);
      return { rc, err, changes: Number(X.sqlite3_changes64(pDb)), lastInsertRowid: Number(X.sqlite3_last_insert_rowid(pDb)) };
    } finally { wasm.dealloc(pSql); wasm.dealloc(pzErr); }
  },
  // Cancellation via progress handler + SharedArrayBuffer flag (needs crossOriginIsolated).
  cancelBuffer(m) {
    interruptFlag = new Int32Array(m.sab);
    installProgress();
    return { installed: true };
  },
  probeBindText() { // reproduces the upstream capi.sqlite3_bind_text bug
    const db = sqlite3.oo1.DB.wrapHandle(checkHandle(), false);
    const st = db.prepare("SELECT ?");
    try { const rc = capi.sqlite3_bind_text(st.pointer, 1, "x", -1, capi.SQLITE_WASM_DEALLOC); return { rc }; }
    catch (e) { return { threw: String(e) }; }
    finally { st.finalize(); db.close(); }
  },
  // Upstream sqlite3_complete(), exported by the same WASM. Used by the host only to decide
  // WHEN to hand accumulated lines to fiddle_exec (fiddle_exec runs any trailing incomplete
  // SQL at end of its input, so continuation lines cannot be fed one at a time).
  complete(m) { const p = wasm.allocCString(m.text); try { return wasm.exports.sqlite3_complete(p) === 1; } finally { wasm.dealloc(p); } },
  info() { return { handle: String(checkHandle()), filename: dbFilename(), vfs: vfsName(), prompt: prompt() }; },
  hook(m) {
    const pDb = checkHandle();
    hookOn = !!m.on;
    capi.sqlite3_update_hook(pDb, m.on ? (_ctx, op, zDb, zTbl, rowid) => {
      post({ type: "change", op: ({ 18: "INSERT", 23: "UPDATE", 9: "DELETE" })[op] ?? op,
        db: typeof zDb === "string" ? zDb : wasm.cstrToJs(zDb),
        table: typeof zTbl === "string" ? zTbl : wasm.cstrToJs(zTbl), rowid: String(rowid) });
    } : 0, 0);
    return { on: hookOn };
  },
};
function listVfs() {
  const names = []; let p = capi.sqlite3_vfs_find(0);
  while (p) { const v = new capi.sqlite3_vfs(p); names.push(wasm.cstrToJs(v.$zName)); p = v.$pNext; v.dispose(); }
  return names;
}

self.onmessage = (ev) => {
  const m = ev.data;
  const h = handlers[m.type];
  if (!h) return post({ type: "reply", id: m.id, ok: false, error: "unknown type " + m.type });
  try {
    const value = h(m);
    post({ type: "reply", id: m.id, ok: true, value });
  } catch (e) {
    post({ type: "reply", id: m.id, ok: false, error: String(e?.message ?? e) });
  }
};

sqlite3InitModule(moduleArg).then((s) => {
  sqlite3 = s; capi = s.capi; wasm = s.wasm;
  globalThis.sqlite3 = s;
  post({ type: "loaded" });
}).catch((e) => post({ type: "out", stream: "stderr", text: "init failed: " + e }));
