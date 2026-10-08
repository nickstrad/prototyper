# POC: upstream DuckDB web shell bound to the app's live `AsyncDuckDB`

Probe for plan.md §8 / `docs/database-editor-plan.md` (DB1). The page embeds
the real `@duckdb/duckdb-wasm-shell` (Rust→WASM, xterm.js) and binds it to the
same `AsyncDuckDB` instance that the page's application code uses. Everything
below was executed in headless Chromium (Playwright 1.62.0, chromium-1234) on
2026-10-07. The raw output is in `evidence/`. Items marked **NOT EXECUTED**
were not run.

| Item | Value |
|---|---|
| `@duckdb/duckdb-wasm` | **1.32.0** (pinned exactly; npm `latest` 1.33.1-dev57.0 is not used) |
| `@duckdb/duckdb-wasm-shell` | **1.32.0** (pinned exactly; it depends on `@duckdb/duckdb-wasm ^1.32.0`, which dedupes to 1.32.0) |
| DuckDB engine | v1.4.3 (banner and `db.getVersion()`) |
| xterm | 5.3.0 (+ fit 0.8.0, webgl 0.16.0, web-links 0.9.0; these are the shell's own deps) |
| Bundle selected | **eh**, from `selectBundle({mvp, eh})`. `crossOriginIsolated=false` |
| COOP/COEP | **Not needed.** Every result here ran without them. The coi bundle was not shipped and was **NOT EXECUTED**. |
| Build | Vite 6.3.5, vanilla TS |

## Verdicts

| | Verdict | Evidence |
|---|---|---|
| (a) Embedding | **PASS.** `shell.embed({ shellModule, container, resolveDatabase })` takes an existing `AsyncDuckDB`. The banner, prompt, `...>` continuation, upstream errors and upstream table rendering all work. | `00`–`10`, `17`–`19` |
| (b) Live sharing | **PASS.** One worker and one database are shared. An app write shows up in the shell and a shell write shows up in the app, including DDL. The two sides are separate connections with normal MVCC isolation. The shell's `.open` silently destroys the shared database and crashes the app. | `20`, `11` |
| (c) Command coverage vs the plan's list | **FAIL for `.tables .schema .mode table/csv/json .headers`.** All of them answer `Unknown command: .X`. Only `.help` exists. The SQL equivalents work. This matches the Q12 scope decision now in `docs/database-editor-plan.md`. | `01`, `12`–`16`, `18` |
| (d) Persistence (OPFS) | **PASS, with conditions.** `opfs://poc.duckdb` READ_WRITE persists app and shell writes across a reload after `CHECKPOINT`. A write without `CHECKPOINT` was lost on reload in 3 of 3 clean runs. A second tab on the same file fails with an access-handle lock. The shell banner still says "transient in-memory". | `60` |
| (e) Static build | **PASS.** `vite build` served by `python3 -m http.server` works with no backend. The engine's **json/parquet extensions autoload from `extensions.duckdb.org`**. Offline, they fail with cryptic errors. Self-hosting them via `custom_extension_repository` fixes this, and that was verified offline. | `50` |
| (f) Lifecycle/leaks | **CONDITIONAL.** `db.terminate()` frees the worker, and remounting on a fresh DB works. The shell has **no dispose API**. It is a page-global singleton: a second mount takes over the first, so two independent shell tabs are impossible. Each mount leaks 2 window `resize` listeners and about 30 JS listeners. Every keystroke sends a TOKENIZE request to the worker. | `30` |

## (a) Embedding API (quoted from the package)

`node_modules/@duckdb/duckdb-wasm-shell/dist/types/src/shell.d.ts`:

```ts
interface ShellProps {
    shellModule: RequestInfo | URL | Response | BufferSource | WebAssembly.Module;
    container: HTMLDivElement;
    resolveDatabase: (p: duckdb.InstantiationProgressHandler) => Promise<duckdb.AsyncDuckDB>;
    backgroundColor?: string;
    fontFamily?: string;
}
export declare function embed(props: ShellProps): Promise<void>;
```

The package exports only `embed`, `getJsDelivrModule` and `PACKAGE_*` constants.
It has no `dispose`, input or output API, and it does not expose the xterm
`Terminal`. The source is in the sourcemap (`src/shell.ts`):

- `embed` calls the wasm-bindgen `init(shellModule)`. The call is a no-op after
  the first time because the module is a singleton. `embed` then calls
  `shell.embed(container, runtime, {fontFamily ?? 'monospace', backgroundColor ?? '#333', withWebGL: hasWebGL()})`,
  awaits `resolveDatabase(progress)`, loads history from IndexedDB, and calls
  `configureDatabase(db)`. It also replays queries encoded in
  `location.hash` (`#…,q1,q2`) and **rewrites `location.hash`** when it starts
  with `#savequeries`. A host that uses hash routing must account for both.
- The shell opens **its own connection** with `db.connectInternal()`. The
  instrumentation recorded one `connectInternal` per mount.
- WebGL renders when it is available. In WebGL mode, the DOM has no text rows.
  The POC therefore reads the real xterm buffer. A test-only hook wraps
  `Terminal.prototype.open` (`src/main.ts`) and does not change the output.
- xterm's CSS is not imported by the shell. The host must import
  `xterm/css/xterm.css`.

## (b) Live sharing (`evidence/20-live-sharing.txt`)

- The app (`db.connect()` on the main thread) ran `INSERT id=6`. The shell's
  `SELECT count(*)` returned 6 and `WHERE id=6` returned the row.
- The shell ran `INSERT id=7`. The app connection saw it, and so did a fresh
  `db.connect()`. `CREATE TABLE notes` in the shell was readable by the app.
- **Transactions:** The shell ran `BEGIN; INSERT id=8`. The shell saw 8 rows
  while the app still saw 7, which is snapshot isolation between connections.
  After `COMMIT`, the app saw the row. An app `UPDATE` of a row that an open
  shell transaction had updated failed with
  `TransactionContext Error: Conflict on update!`. A dangling `BEGIN` in the
  console therefore hides console writes from the app and can make app writes
  fail.
- **`.open` hazard (`evidence/11-open.txt`):** `.open` and `.open foo.duckdb`
  call `AsyncDuckDB.open()` on the **shared** instance. The app's table
  disappeared. The app's existing connection then returned
  `Parser Error: Max expression depth limit of 0 exceeded`, followed by
  `RuntimeError: memory access out of bounds`. With an argument, the shell
  reports `Connected to a read-only remote database at: foo.duckdb.` The host
  cannot intercept dot-commands through the upstream API. Wrapping
  `db.open` (as the instrumentation in `scripts/open-cmd.mjs` does) is one place
  to block it or turn it into an explicit rebind.

## (c) Command coverage

Exact upstream `.help` (`evidence/01-help.txt`):

```text
Commands:
.clear                 Clear the shell.
.examples              Example queries.
.features              Shell features.
.files list            List all files.
.files add             Add files.
.files download $FILE  Download a file.
.files drop            Drop all files.
.files drop $FILE      Drop a single file.
.files track $FILE     Collect file statistics.
.files register $FILE  Register OPFS file handle.
.files paging $FILE    Show file paging.
.files reads $FILE     Show file reads.
.open $FILE            Open database file.
.reset                 Reset the shell.
.timer on|off          Turn query timer on or off.
.output on|off         Print results on or off.
```

| Plan-required | Result in pinned shell |
|---|---|
| `.help` | works (above) |
| `.tables` | `Unknown command: .tables` |
| `.schema` | `Unknown command: .schema` |
| `.mode`, `.mode table`, `.mode csv`, `.mode json` | `Unknown command: .mode` (all four) |
| `.headers on` | `Unknown command: .headers` |

Other commands: `.timer on` prints `Timer enabled` and `Elapsed: 10 ms`.
`.output off` suppresses results. `.reset` prints `Not implemented yet`.
`.files` and `.files list` print `No files registered`, or a table of buffered
files after a `COPY … TO 'x.csv'`. `.features` prints a platform and bundle
feature matrix. `.examples` prints remote-parquet examples.

These SQL equivalents exist and render in the shell's single fixed box format
(`evidence/03,04,18`):

- Tables: `SHOW TABLES;` or `SELECT table_name FROM duckdb_tables();`
- Schema: `DESCRIBE events;` or `SELECT sql FROM duckdb_tables() WHERE table_name='events';`, and `SUMMARIZE events;`
- JSON: `SELECT to_json(e) FROM events e;` or `SELECT json_group_array(e) FROM …`. These autoload the json extension.
- CSV: `COPY (…) TO 'events.csv' (FORMAT csv, HEADER);` writes to an in-memory buffer file, which `.files download events.csv` can download (the download was **NOT EXECUTED**). `TO '/dev/stdout'` does not print; it creates a buffered file.
- No equivalent exists for headers on/off or for changing the table renderer.

The shell's behavior also has these quirks:

- A multiline statement shows `...>` continuation prompts.
- A string containing `;` works.
- After an error, the next statement still runs, but the parser error prints
  its `LINE 1:` caret block **twice**.
- Long lines wrap with a `..>>` marker.
- **Keystrokes typed while a statement is running are dropped.** There is no
  type-ahead. It was observed twice, and the drivers now wait for the prompt.

## (d) Persistence (`evidence/60-opfs.txt`)

`db.open({ path: 'opfs://poc.duckdb', accessMode: READ_WRITE })` with the
default config creates `poc.duckdb` and `poc.duckdb.wal` in OPFS. It needs no
`registerOPFSFileName` call.

The app inserted id=100, the shell inserted id=101, and then `CHECKPOINT` ran.
After a reload (no seeding), the app and the shell both read back 7 rows.
`duckdb_databases()` shows `poc | opfs://poc.duckdb | readonly=false`. An
insert **without** `CHECKPOINT` was gone after a reload in 3 of 3 runs, so the
host must checkpoint after mutations or on `pagehide`.

A second tab in the same origin that opens the same file fails with:
`Failed to execute 'createSyncAccessHandle' on 'FileSystemFileHandle': Access Handles cannot be created if there is another open Access Handle…`.
The file is limited to one handle across the whole origin. The shell and the
app share it without problems because they share one `AsyncDuckDB`.

## (e) Static build and assets (`evidence/50-static-build.txt`)

The wasm and worker files reach the build through Vite `?url` imports in
`src/main.ts`, for example
`import ehWasm from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url'`. The same
applies to the mvp wasm, both workers and `@duckdb/duckdb-wasm-shell/dist/shell_bg.wasm`.
Vite emits them to `dist/assets/` with hashed names, and the URLs go to
`selectBundle` and `embed`. `vite.config.ts` excludes the duckdb packages from
`optimizeDeps`, but must **include** the CJS xterm addons. Without that,
`FitAddon` fails with "does not provide an export named" in dev.

| Asset | Raw | gzip |
|---|---|---|
| duckdb-eh.wasm (fetched) | 34.2 MB | 7.7 MB |
| duckdb-mvp.wasm (shipped, fetched only on non-EH browsers) | 39.4 MB | 8.8 MB |
| shell_bg.wasm | 1.5 MB | 0.43 MB |
| eh worker js | 0.77 MB | 0.19 MB |
| app js (incl. arrow, xterm, shell glue) | 0.60 MB | 0.15 MB |
| self-hosted json+parquet extensions (eh+mvp) | 7.1 MB | — |
| **dist total** | **81 MB** (74 MB without extensions) | |
| **fetched per load (eh)** | ≈37.1 MB raw, ≈8.5 MB gzip if the server compresses | |

A plain static server works. Python serves `.wasm` as `application/wasm`.

**Extensions:** `to_json` and `COPY … (FORMAT parquet)` autoload
`https://extensions.duckdb.org/v1.4.3/wasm_eh/{json,parquet}.duckdb_extension.wasm`.
With all non-origin requests aborted, they fail with `table index is out of bounds`
and `function signature mismatch`.
`scripts/fetch-extensions.sh` copies the extensions into `public/duckdb-extensions/`.
`?ext=local` then runs
`SET custom_extension_repository = '<origin>/duckdb-extensions'` on the app
connection. That setting is global, so the shell inherits it. Offline,
`to_json`, `COPY … parquet` and `read 'e.parquet'` then all worked from the
origin.

## (f) Lifecycle (`evidence/30-lifecycle.txt`)

| State | workers | JS listeners | window listeners added |
|---|---|---|---|
| baseline | 0 | 16 | — |
| db + shell mounted | 1 | 51 | `resize`×2 |
| container removed + `db.terminate()` | **0** | 48 | `resize`×2 (not removed) |
| after 6 mount cycles total | 1 | 243 | `resize`×12 |

- Workers do not leak, and remounting against a fresh DB works. On remount,
  the shell tries to `DISCONNECT` its old connection on the dead worker, which
  logs `cannot send a message since the worker is not set!` without harm.
- xterm `Terminal` instances, the WebGL addon and the window `resize` listeners
  are never disposed. No upstream API exists to dispose them.
- **Double mount:** after a second `embed` into another container, typing in
  tab A produces output in **tab B**, and tab A stops updating. The Rust shell
  state, including the terminal, is one per page.
- If the DB is terminated while a shell is still mounted, every keystroke
  raises a page error (`Cannot read properties of undefined (reading 'offsets')`),
  because the shell tokenizes every keystroke on the worker for syntax
  highlighting.

## Arrow values on the app side (`evidence/40-arrow-types.txt`)

`table.toArray()` rows from `conn.query()`:

| Type | Value | Caveat |
|---|---|---|
| BIGINT | `bigint` | `JSON.stringify(row.toJSON())` **throws** "Do not know how to serialize a BigInt" |
| HUGEINT | `DecimalBigNum` (Arrow `Decimal[38e0]`) | `String()` is exact. JSON is a doubly quoted string. |
| DECIMAL(5,2) 3.14 | `DecimalBigNum`, `String()` = `"314"` | **Scale is lost.** Read the scale from `field.type.scale`. |
| TIMESTAMP | `number`, epoch ms with fractional µs (`1704099600123.456`) | |
| DATE | `number`, epoch ms | |
| INTERVAL 90 MINUTE | `Int32Array [0,0]` | **The value is lost** (MONTH_DAY_NANO). Cast it to VARCHAR in SQL. |
| NULL | `null` | |
| INTEGER[] `[1,2,NULL]` | Arrow `Vector` | `toJSON()` gives `[1,2,null]`, but `toArray()` gives `1,2,0`, so **NULL becomes 0**. |
| BIGINT[] | `Vector` of bigint | JSON throws |
| STRUCT / MAP | `StructRow` / `MapRow` | `toJSON()` works |
| BLOB | `Uint8Array` | JSON gives `{"0":170,"1":0}` |
| UUID | `string` | |

The shell renders the same values correctly from its own Arrow decoding, as
`evidence/19-types-in-shell.txt` shows (BLOB renders as `aa`).

## Recommended binding contract (DuckDB side of the DatabaseEditor host)

This contract is derived from the behavior above. The engine is owned by the
Effect Layer and never by the shell.

```ts
interface DuckDbShellBinding {
  // Mount the ONE page-global upstream shell into `container`, against the live db.
  // Must be a page-level singleton. Tabs reparent this one container; they do not re-embed.
  mount(container: HTMLDivElement, db: AsyncDuckDB): Promise<void>; // resolves after embed()
  // No upstream input/output API: input is the user's keystrokes into xterm; output is xterm.
  // Readiness = embed() resolved.
  identity: { engine: 'duckdb'; version: string; bundle: 'eh' | 'mvp'; path: ':memory:' | `opfs://${string}` };
  // Structured access goes through the app's own connection (db.connect()), never by parsing shell text.
  // App queries normalize BigInt/Decimal/Interval/List as listed above.
  // db.open is wrapped: the shell's `.open` must be refused or surfaced as an explicit rebind.
  // After any successful shell statement there is no hook, so invalidate on a host-visible signal
  // (for example db.runQuery wrapper resolving on the shell's connection id) and CHECKPOINT when OPFS.
  cancel?: never;   // the shell exposes no cancellation
  dispose(): void;  // host-side only: hide or detach the container. The worker ends with db.terminate().
}
```

Required host rules:

1. Create the `AsyncDuckDB` once. Pass `resolveDatabase: async () => db`.
2. Embed the shell once per page. Keep its container alive and move it between
   tabs with CSS or reparenting instead of unmounting it. Re-embedding leaks
   listeners and steals the terminal.
3. Wrap `db.open` and `db.connectInternal`/`db.runQuery` to block `.open` and
   to detect the shell's statements. The wrapper on the shell's connection id
   provides change notification and checkpointing. This is a wrapper on
   engine I/O, not a command parser. Treat it as a design proposal; only the
   wrapping of `open`/`connectInternal`/`disconnect` was executed.
4. With OPFS, run `CHECKPOINT` after writes, and allow one tab per file.
5. Self-host the extensions and set `custom_extension_repository`.
6. Import `xterm/css/xterm.css` and do not use hash routing that collides with
   `#savequeries` or comma-separated hash replay.

## How to rerun

```sh
cd pocs/duckdb-shell
npm ci                                  # pins duckdb-wasm 1.32.0, shell 1.32.0, vite 6.3.5, playwright 1.62.0
./scripts/fetch-extensions.sh           # optional: self-hosted json/parquet extensions
npm run dev &                           # http://localhost:5181 (no COOP/COEP)
node scripts/evidence.mjs               # evidence/00-21 (commands + live sharing)
node scripts/open-cmd.mjs               # evidence/11-open.txt
node scripts/lifecycle.mjs              # evidence/30-lifecycle.txt
node scripts/types.mjs                  # evidence/40-arrow-types.txt
node scripts/opfs.mjs                   # evidence/60-opfs.txt (fresh ephemeral profile each run)
npm run build && python3 -m http.server 5183 --directory dist &
BASE=http://localhost:5183/ node scripts/static-check.mjs   # evidence/50-static-build.txt
```

Page query params: `?manual` skips auto-init, `?path=opfs://x.duckdb` opens an
OPFS file, `?seed=0` skips seeding, and `?ext=local` uses the self-hosted
extensions. Set `COI=1 npm run dev` to add COOP/COEP headers. That run was
**NOT EXECUTED**.
