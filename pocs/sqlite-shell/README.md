# POC: upstream sqlite3 shell (Fiddle WASM) + shared live database

## Verdict: FEASIBLE with the prebuilt Fiddle artifacts. No custom build is needed for the bridge.

The unmodified upstream Fiddle build (SQLite 3.54.0 trunk snapshot, see `PROVENANCE.md`) runs
the real `sqlite3` CLI `main()` in our own page and Worker. The same WASM instance exports
the full sqlite3 C API and bundles the official sqlite3 JS API. The application can
therefore run structured queries on **the shell's own `sqlite3*`** (`fiddle_db_handle()`).
Executed in Chrome: an app-side write is visible to shell `SELECT`, and a shell-side write
is visible to app-side structured queries. The update hook on that handle reports shell writes.

A custom build is still recommended for production pinning. The live Fiddle is an unreleased
trunk snapshot. See "Decisions" below.

Everything below was executed unless it is marked **(not executed)** or **(source reading)**.

## Exports found (`evidence/01-exports-prebuilt.txt`, `scripts/inspect-exports.ts`)

`fiddle-module.wasm`: 279 exports, 214 of them `sqlite3_*`.

- Fiddle exports: `fiddle_main`, `fiddle_exec`, `fiddle_db_handle`, `fiddle_db_filename`, `fiddle_db_vfs`,
  `fiddle_reset_db`, `fiddle_export_db`, `fiddle_interrupt`, `fiddle_get_prompt`, `fiddle_db_arg`, `fiddle_experiment`.
  **There is no `fiddle_the_db`.** The handle getter is `fiddle_db_handle`.
- Core C API, all present: `sqlite3_prepare_v2/v3`, `step`, `column_count/name/text/type/int64/double/blob/bytes`,
  `finalize`, `exec`, `changes/changes64`, `total_changes(64)`, `last_insert_rowid`, `errmsg`, `stmt_readonly`,
  `get_autocommit`, `complete`, `interrupt`, `progress_handler`, `update_hook`, `commit_hook`, `serialize`,
  `deserialize`, and `bind_{int,int64,double,text,blob,null,zeroblob,pointer,parameter_count,parameter_index,parameter_name}`.
  Also `malloc`/`free`/`sqlite3_malloc`/`sqlite3_free`.
- Why: upstream `ext/wasm/GNUmakefile` builds fiddle with
  `-sEXPORTED_FUNCTIONS=@$(EXPORTED_FUNCTIONS.fiddle)`. That file is generated from
  `ext/wasm/api/EXPORTED_FUNCTIONS.c-pp` with `-Dfiddle`. It contains the whole API list plus
  the `//#if fiddle` block of `_fiddle_*` symbols (source reading at check-in 4bfc6e53a9). The
  release 3.53.4 file has the same structure, but it lacks `_fiddle_get_prompt`. In current
  trunk, `ext/wasm/fiddle.make` no longer exists because it was merged into `GNUmakefile`.
- Emscripten runtime: `Module.ccall`/`cwrap` are **not** exported. `Module.FS` and
  `Module.wasmMemory` are exported. They are not needed: `fiddle-module.js` is the full
  sqlite3 JS bundle, and `sqlite3InitModule()` resolves to the `sqlite3` object.
  `sqlite3.wasm.exports.*` gives raw WASM functions. The helpers `xWrap` (the cwrap
  equivalent), `heap8u()`, `cstrToJs`, `allocCString`, `peekPtr`/`pokePtr`, `alloc`/`dealloc`,
  `allocMainArgv` and `installFunction` are also available, as are `sqlite3.capi.*` and
  `sqlite3.oo1.DB.wrapHandle()`.

## Bridge test result (`evidence/04-bridge.txt`)

All steps run in the same Worker and the same WASM instance on the same `sqlite3*` (`445696`).

1. The shell `fiddle_exec("CREATE TABLE t(...); INSERT ... 'from-shell'")` runs. Then the app
   runs raw `prepare_v2/step/column_*` and gets `{"columns":["id","name"],"rows":[[1,"from-shell"]]}`.
2. The app runs raw `sqlite3_exec(pDb, "INSERT ... 'from-app'")` and gets `rc 0, changes 1, lastInsertRowid 2`.
   The shell `SELECT * FROM t;` in `.mode table` then shows both rows.
3. The update hook is installed by the app on the shell handle. A shell `INSERT` followed by
   `UPDATE` emits `{op:INSERT,table:t,rowid:3}` and `{op:UPDATE,...}`. The app then reads `shell-2b` with a bound parameter.
4. Shell `.mode json` does not affect app decoding, and app queries do not reset the shell
   mode. The shell's next `SELECT` is still JSON.
5. Types: `9007199254740993` comes back as BigInt, NULL as `null`, a blob as `Uint8Array [0,255,16]`,
   UTF-8 text intact. The `oo1.DB.wrapHandle(pDb, false)` path returns the same rows.
6. Errors are structured on the app side (`prepare rc=1: no such table: nope`). They are never parsed from shell text.
7. **There is one connection and no isolation.** After shell `BEGIN; INSERT`, the app sees
   the uncommitted row and `autocommit=false`. After shell `ROLLBACK`, the row is gone.
8. Export uses `sqlite3_js_db_export` and returns 16384 bytes starting `SQLite format 3`.
   Reset uses `fiddle_reset_db`, which keeps the same handle and empties the schema for both sides.
   Import uses `sqlite3_deserialize(pDb,"main",...)`, which also keeps the same handle (the VFS
   becomes `memdb`). Both sides see the imported rows, and later shell writes are visible to the app.
9. Shell `.open :memory:` **replaces the connection** (handle 445696 → 681352). The bridge
   detects this because it re-reads `fiddle_db_handle()` on every call. Because the upstream
   argv includes `-safe`, `.open` opened the new db **read-only**
   (`attempt to write a readonly database`). See gotchas.

Upstream JS bug found: `capi.sqlite3_bind_text(pStmt, i, "jsString", ...)` throws
`ReferenceError: pMem is not defined` (executed probe). The cause is `Array.isArray(pMem)` in
`sqlite3-api-glue.c-pp.js`, where it should be `text`. The same line exists in the 3.53.4
release source (source reading). The POC binds text and blobs through raw
`wasm.exports.sqlite3_bind_text/blob`.

## Command walkthrough (real output)

- `evidence/02-walkthrough-upstream-argv.txt`: argv `-bail -safe /fiddle.sqlite3`, the same as sqlite.org/fiddle.
- `evidence/03-walkthrough-no-bail-no-safe.txt`: argv `/fiddle.sqlite3`.
- `evidence/07-xterm-keyboard-{raw,complete}.{txt,png}`: typed through xterm.js by Playwright.
- `evidence/05-file-commands-{safe,nosafe}.txt`: file and host commands.
- `evidence/06-help-vs-native.txt`: fiddle `.help` compared with `/usr/bin/sqlite3` `.help`.
- `evidence/08-coi-cancel-opfs.txt`: COOP/COEP mode, cancellation, OPFS.
- `evidence/09-main-thread.txt`: the module running without a Worker.

`.help`, `.tables`, `.schema`, `.mode table|csv|json`, `.headers on|off` and multiline SQL
submitted as one unit all work with the real shell formatting. Strings containing `;` work.
An error followed by a valid command works. The default mode is the 3.54 rounded `box` style.

## Answers to the specific questions

- **Worker only?** No. It also runs on the main thread (`web/mainthread.html`, evidence 09).
  It is synchronous and blocks the UI, so use a Worker. The OPFS VFS refuses to run on the main thread.
- **COOP/COEP?** They are not required for the shell or the bridge. sqlite.org serves Fiddle
  without them, and evidence 02–04 ran without them. With COOP/COEP
  (`crossOriginIsolated=true`), two more features work: SharedArrayBuffer cancellation and the
  `opfs`/`opfs-wl` VFSes. The OPFS proxy needs `?sqlite3.dir=<vendor dir>` on the Worker URL,
  or it 404s relative to the Worker. Under COI, `.open file:/x.db?vfs=opfs` without `-safe`
  persisted across `page.reload()`.
- **VFS:** the default db is `/fiddle.sqlite3` on `unix-none` over Emscripten MEMFS, so it is transient.
  Also available: `memdb`, `kvvfs`, `unix*`, and `opfs`/`opfs-wl` when COI is on.
- **`.open`:** it works and replaces the shell connection. With `-safe` it opens **READONLY**
  (`shell.c.in`: `if( p->bSafeMode ) openFlags = SQLITE_OPEN_READONLY;`). For a non-existent
  file this fails and the shell falls back to a substitute in-memory db. `.open` is missing
  from `.help` in the fiddle build, but the command exists.
- **`.save`, `.backup`, `.restore`, `.read`, `.output`, `.once`, `.import`, `.shell`, `.system`, `.load`,
  `.excel`, `.www`, `.cd`, `.nonce`, `.quit`, `.exit`** are compiled out by `SQLITE_SHELL_FIDDLE`. All of them answer
  `Error: unknown command or invalid arguments: "X". Enter ".help" for help`, which is the shell's own response.
  `.quit` and `.exit` do not kill the module.
- **`.help` coverage:** fiddle lists 47 commands and native `/usr/bin/sqlite3` (3.54.0 Apple
  build) lists 68. The 22 missing commands are the compiled-out ones above, plus
  `.archive .clone .dbstat .hex .rekey .text`. Those six may be version or Apple drift.
  `.diskused` is fiddle-only.
- **Cancellation:** `fiddle_interrupt` cannot help, because the Worker is busy and cannot
  receive the message. This is noted upstream in `fiddle-worker.js`. Under COI, a
  `sqlite3_progress_handler` that reads a SharedArrayBuffer flag interrupted an infinite
  recursive CTE about 500 ms after `cancel()`. The shell printed `Error near line 1: interrupted` and stayed usable.
  Without COI, the capability is unavailable.

## Gotchas

1. **The live Fiddle is an unpinned trunk snapshot.** It is "not an officially-supported
   deliverable" and can change or vanish. Vendor or rebuild it; never hotlink it.
2. **Each `fiddle_exec` call is a complete input stream.** Trailing SQL without a `;` is
   executed at end of input. A multiline statement typed one line per call fails (raw mode,
   evidence 07-raw). The host must accumulate lines and submit only when the shell would.
   `web/main.js` mirrors the 3-condition rule from `shell.c` `process_input()`: a dot or `#`
   line with no pending SQL goes immediately; otherwise SQL accumulates until it contains
   `;` **and the upstream `sqlite3_complete()` export** returns true (or a lone `/`/`go` line).
   This is not an SQL splitter, because the shell still executes the whole buffer.
   Evidence 07-complete shows this working, including `'a;\nb'`.
3. **Continuation prompt:** `fiddle_get_prompt()` returns only the main prompt
   (`prompt_string(p,0)`). The host shows a fixed `   ...> `, which is a cosmetic deviation.
   A one-line upstream patch could export the continuation prompt (`bContinue=1`).
4. **The shell echoes dot-commands itself** (`if('.'==*zSql) puts(zSql);`), so a typed
   `.tables` appears twice in a terminal. Sending without a trailing `\n` avoids the extra blank line.
5. **`-bail`** (upstream argv): an error stops the rest of *that submission*, but later
   submissions still run. **`-safe`** makes `.open` read-only. Recommend argv without `-safe`.
   Decide on `-bail` explicitly; without it, the native default behavior applies.
6. Errors are formatted as non-interactive (`Parse error near line N:`), because fiddle sets
   `stdin_is_interactive = 0`. The native interactive CLI omits "near line N". This is upstream behavior; keep it.
7. **Single thread.** Shell input and app queries serialize in one Worker, so a long shell
   query blocks app reads until it finishes or is cancelled (cancellation needs COI).
8. **Handle identity can change.** Shell `.open` swaps `sqlite3*`, so re-read `fiddle_db_handle()`
   per call and re-arm hooks (the POC emits `handle-changed`). The plan requires the host to
   disable or surface `.open`. Reset (`fiddle_reset_db`) and import (`sqlite3_deserialize`)
   keep the handle.
9. The update hook fires per row **before commit**, including rows later rolled back. It does
   not fire for DDL. For "publish only after success", check `sqlite3_get_autocommit` and
   `total_changes64`/`PRAGMA schema_version` deltas after each exec, or use commit and rollback
   hooks **(not executed)**.
10. `capi.sqlite3_bind_text` bug (above). Use raw exports, or `oo1.Stmt.bind`, which was **not
    exercised with strings here**.
11. `capi.sqlite3_shutdown()` must run before `fiddle_main` (upstream does this). JS-registered
    VFSes (opfs) survived it in our run.
12. CSV mode emits `\r\n` line endings, per upstream. xterm handles them; plain-text consumers should not strip `\r`.

## Recommended binding contract (derived from the executed probes)

One Worker owns **one** Fiddle WASM instance, which is both the shell and the browser `DatabaseService` engine.
A separate sqlite-wasm instance **cannot** share this live database, because its memory and
MEMFS are separate. The browser D1 service should be the bridge (plan §9 `sharesDatabaseWith`).

```ts
interface SqliteShellRuntime {                       // Effect Layer, scoped; one per prototype db
  ready: Effect<{ libversion; sourceId; vfs; filename; crossOriginIsolated }, ShellError>;
  // --- shell (upstream text, untouched) ---
  mount(el: HTMLElement): Effect<void, ShellError, Scope>;   // xterm + line discipline (sqlite3_complete rule)
  write(input: string): Effect<{ prompt: string }, ShellError>; // one complete unit -> fiddle_exec
  output: Stream<{ stream: "stdout" | "stderr"; text: string }>; // one emscripten line per item
  // --- structured engine access on fiddle_db_handle() (raw exports) ---
  execute(sql: string, params?: readonly SqlValue[], opts?: { maxRows?: number }):
    Effect<{ columns: string[]; rows: SqlValue[][]; changes: number; totalChangesDelta: number;
             lastInsertRowid: bigint | number; autocommit: boolean; statements: number }, DatabaseError>;
  changes: Stream<DatabaseChange>;        // derived after each successful exec/write (see gotcha 9)
  handleChanged: Stream<{ from: string; to: string }>; // shell `.open` swapped the connection
  reset(): Effect<void, DatabaseError>;   // fiddle_reset_db (same handle) + reseed via execute
  export(): Effect<Uint8Array, DatabaseError>;            // sqlite3_js_db_export
  import(bytes: Uint8Array): Effect<void, DatabaseError>; // sqlite3_deserialize into same handle
  cancel: Capability & (() => void);      // available only if crossOriginIsolated (SAB + progress handler)
  dispose(): Effect<void>;                // worker.terminate(); scope finalizer
}
type SqlValue = null | number | bigint | string | Uint8Array;
```

Worker message protocol used by the POC (`web/shell-worker.js`): `init{args}`, `exec{text}`,
`query{sql,params,via}`, `cexec{sql}`, `complete{text}`, `reset`, `export`, `import{bytes,mode}`,
`hook{on}`, `cancelBuffer{sab}`, `info`. Replies are `{type:'reply',id,ok,value|error}`. Events are
`out{stream,text}`, `change{op,db,table,rowid}`, `handle-changed`, `loaded`. Upstream
`fiddle-worker.js` uses a similar protocol: `shellExec`, `db-reset`, `db-export`, `open`,
`interrupt` → `stdout`, `stderr`, `working`, `wasm-info{prompt}`, `fiddle-ready`, `sqlite-version`.
It has no structured-query message. That is why the POC uses its own worker over the unmodified module.

Required static assets: `fiddle-module.js` (828 KB), `fiddle-module.wasm` (1.4 MB,
`application/wasm`), and optionally `sqlite3-opfs-async-proxy.js` for OPFS. The Worker URL must
have `?sqlite3.dir=` pointing at them. No headers are required, and COOP/COEP are optional (cancellation, OPFS).

## Build path (documented; **not attempted**, because the prebuilt has every needed export)

Use it to pin a release and to patch the continuation prompt or the bind_text bug.

```sh
# local only; never sudo/brew
git clone https://github.com/emscripten-core/emsdk pocs/sqlite-shell/.emsdk
pocs/sqlite-shell/.emsdk/emsdk install 5.0.1 && pocs/sqlite-shell/.emsdk/emsdk activate 5.0.1
source pocs/sqlite-shell/.emsdk/emsdk_env.sh
curl -O https://sqlite.org/2026/sqlite-src-3530400.zip && unzip sqlite-src-3530400.zip   # canonical tree, not amalgamation
cd sqlite-src-3530400 && ./configure --enable-all && make sqlite3.c
cd ext/wasm && make fiddle          # -> ext/wasm/fiddle/fiddle-module.{js,wasm}; needs GNU make, tclsh, wabt (wasm-strip)
```

`building.md` says the canonical build needs a source tree (not the amalgamation), GNU Make,
emsdk and wabt ≥ 1.36. Emscripten output is not byte-reproducible across emsdk versions.
Upstream used emsdk 5.0.1. `/usr/bin/tclsh` 8.5.9 is present but untested.

## How to rerun

```sh
cd pocs/sqlite-shell
npm install                                   # playwright + @xterm/xterm (gitignored node_modules)
deno run --allow-read scripts/inspect-exports.ts vendor/fiddle/fiddle-module.wasm   # [--all]
node scripts/run-walkthrough.mjs              # starts Deno servers on :8787 (plain) and :8788 (COOP/COEP),
                                              # drives system Chrome (PW_CHANNEL=chrome), rewrites evidence/*
PORT=8787 deno run --allow-net --allow-read --allow-env scripts/serve.ts   # manual: open /web/index.html
```

URL options for `web/index.html`: `?args=/fiddle.sqlite3` sets the shell argv (comma-separated;
the default is the upstream `-bail,-safe,/fiddle.sqlite3`). `?linebuf=raw|complete` sets the line mode.
Playwright 1.64 wanted `chromium_headless_shell-1248`, which is not cached, so the runner uses
`channel: "chrome"`.

## Decisions for the user

1. **Pin source:** vendor the live trunk snapshot as-is (3.54.0 / 4bfc6e53a9, works now), or
   rebuild Fiddle from the 3.53.4 release with local emsdk 5.0.1 (reproducible and tagged, but
   3.53.4 lacks `fiddle_get_prompt`).
2. **Shell argv:** drop `-safe` (otherwise `.open` is read-only and OPFS open fails), and choose whether to keep `-bail`.
3. **Browser D1 service = the shell-owned engine (bridge).** A separate sqlite-wasm worker
   cannot share live data. D1's native Deno path can stay separate.
4. **Serve COOP/COEP?** It is needed only for cancellation and OPFS persistence.
