# POC: SQLite `DatabaseService` (browser + Deno, Effect 4.0.2)

Proves the application-side SQLite service independent of any shell. Everything
below marked **[executed]** was run on 2026-10-07 and has evidence under
`evidence/`. Anything else is labelled **[not executed]**.

## Verdicts

| Question | Verdict |
| --- | --- |
| Browser service over a Worker with OO1 | **Works** [executed]. Own worker (`src/worker.ts`) + OO1. Do not use Worker1/Promiser1: upstream README marks them deprecated as of 2026-04-15. |
| `opfs-sahpool` without COOP/COEP | **Works**, data survives a reload, from a plain static server [executed]. |
| `opfs` / `opfs-wl` without headers | **Unavailable, and init says nothing**: the VFS is not registered, no console error, and opening with it gives `SQLITE_ERROR: sqlite3 result code 1: no such vfs: opfs`. With COOP/COEP both work and survive a reload [executed]. |
| Second tab on `opfs-sahpool` | **Fails** with `NoModificationAllowedError` [executed]. `pauseVfs()` in tab A lets tab B take over, **but only from a fresh Worker in B**. Retrying in the Worker whose install failed keeps failing. |
| `@sqlite.org/sqlite-wasm` under Deno | **Runs, memory only**. It resolves to `dist/node.mjs`. Opening a file path fails with `SQLITE_CANTOPEN` [executed]. |
| `node:sqlite` under Deno 2.7.14 | **Works** with 3 hazards that need workarounds (see Deno section) [executed]. |
| Backend for native tests/CLI (R9) | **`node:sqlite`** for the native CLI/API (real files). Also run the conformance suite against **sqlite-wasm memory in Deno**, because it is the same build as the browser (3.53.4 vs node:sqlite's 3.50.2). |
| JSON result shapes, native vs browser | **Identical after normalization** [executed, `evidence/deno-shape-parity.json`]. Raw driver values differ (see BigInt section). |
| Effect 4.0.2 service/layer/pubsub | **Works** in `deno test` (12/12) and in the browser over the worker driver (memory, sahpool, opfs) [executed]. |
| Export/import | **Works** for memory, sahpool and opfs [executed]. See the API table. |
| Static build | `vite build` then serving `dist/` from a plain static server: the worker, wasm and opfs-async-proxy all resolve. The only 404 is `/favicon.ico` [executed]. |

## Versions

| Item | Version |
| --- | --- |
| `@sqlite.org/sqlite-wasm` | 3.53.4-build2 (`sqlite3.version.libVersion` = 3.53.4) |
| `effect` | 4.0.2 |
| `vite` | 8.3.3 (Rolldown) |
| Deno / V8 / bundled TS | 2.7.14 / 14.7.173.20 / 5.9.2 |
| `node:sqlite` SQLite (Deno 2.7.14) | 3.50.2 |
| Node | v22.18.0 (Vite, Playwright, static server) |
| Playwright | 1.64.0. It expects chromium-1248, so the probe uses `executablePath` = the cached `chromium-1234` (Chrome for Testing **151.0.7922.34**). |
| TypeScript (browser typecheck) | 7.0.2 (`npx tsc -p tsconfig.json` passes) |

## Layout and how to rerun

```
src/protocol.ts          QueryResult + Cell JSON encoding + tasks schema/seed (project.md §11)
src/wasm-exec.ts         OO1 execute (browser worker AND Deno) + sqlite3_deserialize import
src/node-sqlite-exec.ts  node:sqlite execute with identical semantics
src/service.ts           Effect v4 DatabaseService (Context.Service, Layer.effect, acquireRelease, Semaphore, PubSub)
src/node-driver.ts       Deno native DriverFactory (node:sqlite, memory or file)
src/wasm-driver-deno.ts  Deno sqlite-wasm DriverFactory (memory)
src/worker.ts            Browser worker: probe / installSahpool / open(vfs) / exec / export / importLive / pause / unpause
src/worker-client.ts     RPC client + browser DriverFactory (one Worker per handle)
src/main.ts, index.html  Vanilla page; exposes window.poc for Playwright
tests/                   deno test (service + cross-engine shape parity)
scripts/                 serve.mjs (static, --coi adds headers), browser-probe.mjs, quick-probe.mjs, summarize-probe.mjs
probes/                  one-off Deno probes whose output is in evidence/
```

```sh
npm install
deno task test        # -> evidence/deno-test.txt
deno task check
npm run typecheck && npm run build
npm run serve & npm run serve:coi &   # :4173 plain, :4174 COOP/COEP
npm run probe:browser                 # -> evidence/browser-probe.json + browser-probe-summary.txt
```

## Capability matrix [executed, `evidence/browser-probe-summary.txt`]

Chrome for Testing 151, built `dist/` served by `scripts/serve.mjs`. Every
column uses a fresh browser context.

| VFS | No headers | COOP/COEP | Survives reload | 2 tabs, same origin |
| --- | --- | --- | --- | --- |
| memory (`:memory:`, `dbVfsName()` = `unix-none`; after deserialize `memdb`) | ok | ok | no (by design) | independent DBs |
| `opfs-sahpool` | **ok** | ok | **yes** (both) | **2nd tab fails**: `installOpfsSAHPoolVfs` rejects with `NoModificationAllowedError: Failed to execute 'createSyncAccessHandle' on 'FileSystemFileHandle': Access Handles cannot be created if there is another open Access Handle or Writable stream associated with the same file.` The lock is on the pool directory, not the db file. |
| `opfs` | **no such vfs: opfs** | ok | yes | **both tabs read and write**; A sees B's insert |
| `opfs-wl` | **no such vfs: opfs-wl** | ok | yes | **both tabs read and write**; A sees B's insert |

sahpool hand-off sequence [executed, both header modes]:

1. A opens. B's install fails.
2. A runs `db.close()` and then `pool.pauseVfs()`. Result: `isPaused: true`, and `sqlite3_vfs_find("opfs-sahpool")` is null.
3. B retries `installOpfsSAHPoolVfs` in the **same** worker. It **still fails** with the same error, because the failed install is not retryable in that worker.
4. B spawns a **new worker**, which opens, inserts and then runs `pauseVfs()`.
5. A runs `await pool.unpauseVfs()`, reopens, and sees B's row.

So pausing hands the database over. It is not concurrent access. You need a
coordinator such as a Web Locks or BroadcastChannel leader, and the losing tab
must use a fresh Worker. That coordinator is **[not executed]**.

### Exact detection results

| Probe (in Worker, after `await sqlite3InitModule()`) | no headers | COOP/COEP |
| --- | --- | --- |
| `self.crossOriginIsolated` / `typeof SharedArrayBuffer` | false / `undefined` | true / `function` |
| `sqlite3.capi.sqlite3_js_vfs_list()` | `unix-none, memdb, kvvfs, unix-excl, unix-dotfile, unix` | `unix-none, opfs-wl, opfs, memdb, kvvfs, unix-excl, unix-dotfile, unix` |
| `!!capi.sqlite3_vfs_find("opfs")` / `("opfs-wl")` | false / false | true / true |
| `!!capi.sqlite3_vfs_find("opfs-sahpool")` before install | false | false |
| …after `await sqlite3.installOpfsSAHPoolVfs({})` | true (`pool.vfsName === "opfs-sahpool"`) | true |
| `Object.keys(sqlite3.oo1)` | `DB, Stmt, JsStorageDb` | `DB, Stmt, JsStorageDb, OpfsDb, OpfsWlDb` |
| `"OpfsSAHPoolDb" in sqlite3.oo1` | **false**. The class is only `pool.OpfsSAHPoolDb`. | false |
| **`'opfs' in sqlite3`** (upstream README's detection) | false | **false even when opfs works**. Bootstrap deletes `sqlite3.opfs` outside test builds (`index.mjs` ~L4737), so this check is useless. |

Upstream feature check (`index.mjs` `vfsInstallationFeatureCheck`; init stays
silent when it fails): `"Cannot install OPFS: Missing SharedArrayBuffer and/or
Atomics. The server must emit the COOP/COEP response headers…"`.

Recommended detection code. It is the code the POC executed:

```ts
const sqlite3 = await sqlite3InitModule();
const hasOpfs = !!sqlite3.capi.sqlite3_vfs_find("opfs");      // needs COOP/COEP + Worker
let pool: SAHPoolUtil | undefined;
try { pool = await sqlite3.installOpfsSAHPoolVfs({}); }        // no headers needed, Worker only
catch (e) { /* NoModificationAllowedError => another tab/worker owns the pool */ }
const db = pool ? new pool.OpfsSAHPoolDb("/tasks.sqlite3")
       : hasOpfs ? new sqlite3.oo1.OpfsDb("/tasks.sqlite3", "c")
       : new sqlite3.oo1.DB(":memory:", "c");                  // visible "memory" fallback
```

Side cost of COOP/COEP [executed, server log]: each sqlite worker loads
`sqlite3-opfs-async-proxy.js?vfs=opfs` and `?vfs=opfs-wl`, which starts 2
extra workers, even when you only use memory or sahpool. You can turn this off
with `globalThis.sqlite3ApiConfig = { disable: { vfs: { opfs: true, "opfs-wl": true } } }`
(the keys come from `index.mjs`). **[not executed]**

## Deno [executed]

- **`npm:@sqlite.org/sqlite-wasm` in Deno**: resolves to `dist/node.mjs`. Init,
  memory DBs, `sqlite3_js_db_export` and `sqlite3_deserialize` all work. The VFS
  list is the browser one. `new oo1.DB("/abs/path.db","c")` throws
  `SQLite3Error: SQLITE_CANTOPEN: sqlite3 result code 14: unable to open database file`
  and writes no file. Evidence: `evidence/deno-sqlite-wasm-*.txt`.
- **`node:sqlite` (`DatabaseSync`)** works. It has 3 hazards; the POC works
  around each one in `src/node-sqlite-exec.ts`.
  1. By default, reading an integer above 2^53 **throws**
     `RangeError: Value is too large to be represented as a JavaScript number`.
     Fix: `stmt.setReadBigInts(true)`.
  2. `db.prepare(sql)` **silently ignores everything after the first
     statement**. Fix: walk the SQL with `stmt.sourceSQL`, which is the exact
     prefix including the `;`.
  3. **Reading `.sourceSQL` on a statement prepared from whitespace- or
     comment-only text segfaults Deno 2.7.14 (exit 139)**
     (`evidence/deno-node-sqlite-empty-statement-segfault.txt`). Fix: strip
     leading trivia (`skipTrivia`) before every `prepare`.
  - There is no `serialize()`/`deserialize()` (only `backup()`). Export uses
    `VACUUM INTO <tmp>`. Import into `:memory:` uses `ATTACH` plus schema
    replay plus `INSERT … SELECT`.
  - `stmt.run()` on a SELECT returns stale `changes` from the previous write.
    Both drivers therefore compute `changes` as a `total_changes()` delta.
    OO1's `db.changes()` is sticky in the same way.
- **R9 recommendation**: use `node:sqlite` as the native adapter, because it
  needs no extra dependency and supports real files. Run the shared conformance
  suite against **both** `node:sqlite` and sqlite-wasm memory in Deno. The
  wasm run is the browser engine build, so it catches SQL or behaviour drift
  from the 3.50.2 → 3.53.4 version gap. Keep the 3 workarounds and the
  normalizer in the native adapter.

## BigInt / blob / boolean / null [executed]

Raw driver values (`evidence/deno-*-probe.txt`, browser `exec` results):

| SQL value | sqlite-wasm OO1 (`rowMode:"array"`) | node:sqlite default | node:sqlite `setReadBigInts(true)` |
| --- | --- | --- | --- |
| INTEGER, safe range | `number` | `number` | `bigint` |
| INTEGER > 2^53 | `bigint` (`wasm.bigIntEnabled` true) | **throws RangeError** | `bigint` |
| `1=1`, `true` | `number` 1 | number 1 | `bigint` 1n |
| REAL `2.0` | `number` 2 | number 2 | number 2 |
| BLOB | `Uint8Array` | `Uint8Array` | `Uint8Array` |
| NULL | `null` | `null` | `null` |
| row object | n/a (array) | `[Object: null prototype]` | n/a |

`encodeCell` (`src/protocol.ts`) normalizes both engines to JSON:

- integers become `number` when safe, otherwise `{ "$type": "bigint", "value": "9007199254740993" }`;
- BLOBs become `{ "$type": "blob", "base64": "AP8Q" }`;
- booleans become 0/1;
- `null` stays `null`.

After encoding, both engines give identical results for every case in
`tests/shapes.test.ts`. Those cases cover duplicate column names (`i, i AS i`),
`count(*)` names, INT64 min/max, multiple statements and comment-only SQL.

Loss: REAL `2.0` and INTEGER `2` cannot be told apart in JSON or in JS.
Declared column types are available through `PRAGMA table_info`.

## Execute semantics (both engines, identical) [executed]

- Every statement in the SQL text runs.
- `columns` and `rows` come from the **first statement that has result
  columns**. This matches OO1 `exec({columnNames, callback})`; later SELECTs
  are only stepped once.
- `changes` is the `total_changes()` delta. It is 0 for SELECT and DDL.
- `schemaChanged` is true when `PRAGMA schema_version` moved.
- `truncated` is true when rows reached `maxRows` (default 1000).
- An error in statement *n* leaves statements 1..n-1 applied, because nothing
  wraps them in a transaction. The service publishes **no event** in that
  case, so subscribers can be stale after a partly applied multi-statement
  script. See the open items.
- The OO1 build writes `sqlite3_step() rc= 1299 SQLITE_CONSTRAINT_NOTNULL SQL = …`
  to the console when a statement fails. It does not affect behaviour.

## Effect 4.0.2 wrapping [executed]

- **v4 name check**: the service module is **`Context`** (`Context.Service`,
  `Context.get`, `Context.Reference`). There is no `ServiceMap` module in
  4.0.2; that name existed only during the betas. `Layer.effect(Tag, effect)`
  removes `Scope` from the requirements, so an `acquireRelease` inside it is
  tied to the layer's scope.
- Other APIs used:
  - `Data.TaggedError`
  - `Effect.tryPromise({ try, catch })`
  - `Effect.acquireRelease`
  - `Semaphore.make(1)` with `sem.withPermit`
  - `Ref`
  - `PubSub.unbounded`, `PubSub.publish`, `PubSub.subscribe` (scoped), `PubSub.takeUpTo`, `PubSub.shutdown`
  - `Stream.fromPubSub`
  - `Effect.flip`, `Effect.catchTag`, `Effect.result`. A Result has `_tag`
    `"Success"`/`"Failure"` with `.success`/`.failure`.
  - `Effect.forkChild` with `Fiber.join`
  - `Scope.make`, `Scope.provide`, `Scope.close`, `Layer.build`

```ts
export class DatabaseError extends Data.TaggedError("DatabaseError")<{
  readonly operation: string; readonly message: string; readonly cause: unknown;
}> {}
export class Database extends Context.Service<Database, DatabaseShape>()("prototyper/Database") {}
export const layer = (opts: DatabaseOptions): Layer.Layer<Database, DatabaseError> =>
  Layer.effect(Database, make(opts));

// inside make():
const lock = yield* Semaphore.make(1);
const pubsub = yield* PubSub.unbounded<DbEvent>();
const current = yield* Effect.acquireRelease(
  Effect.gen(function* () {
    const driver = yield* call("open", () => opts.factory.open({ fresh: false }));
    yield* initialize(driver, opts);                 // schema+seed once, PRAGMA user_version marks it
    return yield* Ref.make<Driver | undefined>(driver);
  }),
  (ref) => Effect.gen(function* () {
    const d = yield* Ref.get(ref);
    if (d) yield* Effect.promise(async () => await d.close());   // closes db + terminates worker
    yield* PubSub.shutdown(pubsub);
  }),
);
const execute = (sql: string) =>
  withDriver("execute", (d) => d.execute(sql)).pipe(
    Effect.tap((r) => r.changes > 0 || r.schemaChanged
      ? PubSub.publish(pubsub, { _tag: "Changed", changes: r.changes, schemaChanged: r.schemaChanged })
      : Effect.void),
    lock.withPermit,                                   // serializes execute/reset/import
  );
```

Reset and import go through one `swap`, which runs under the same permit:

1. For an import, snapshot the current data with `exportBytes`.
2. **Close the old handle first**. sahpool and opfs cannot open a second handle
   on the same file.
3. Open the new handle (`fresh`, optionally from `bytes`).
4. For an import, run `PRAGMA quick_check`. `sqlite3_deserialize` accepts
   garbage after a valid header, and the POC observed this as
   `SQLITE_CORRUPT` on the next query.
5. Run initialize (schema and seed).
6. Store the new handle in the `Ref`.
7. Publish the event.

If any step fails, the service reopens the snapshot (or fresh seeds), stores
it, and fails with `DatabaseError`. The service object stays the same object
throughout.

`deno test` results, 12/12 passed (`evidence/deno-test.txt`). Each test ran
against both node:sqlite and sqlite-wasm:

- Bad SQL gives a `DatabaseError` (`operation: "execute"`, message contains
  `syntax error`). `catchTag` works, and no event is published.
- The finalizer closes the driver when the scope closes; it is asserted in
  every test.
- `reset()` keeps the same service object (`before === yield* Database`),
  closes the old handle exactly once, restores seeds `[1,2,3]`, and publishes
  `["Changed","Reset"]`.
- Event count for the sequence insert, select, 0-row update, NOT NULL failure,
  4-row update, CREATE INDEX: exactly 3 events, `{changes:1}`, `{changes:4}`,
  `{changes:0, schemaChanged:true}`.
- Export, reset, then import restores the data.
- A non-SQLite import is rejected before the live handle is touched. A corrupt
  import with a valid header fails with `DatabaseError(import)`, the
  pre-import snapshot is restored, and no event is published.
- `changes` as a Stream (`Stream.take(2)`) receives `Changed, Reset`.

Browser run [executed, `evidence/browser-probe-summary.txt`, "effect service"]:
the same service and layer over `workerFactory` ran for memory and sahpool in
both header modes, and for opfs with COOP/COEP. It gave the same results:
a typed failure, events `[Changed, Reset]`, seeds restored, and `closes: 2`
(the initial handle on reset, then the replacement on scope close).

Reset on sahpool uses `close` then `worker.terminate()`, then a new Worker
installs the pool again. This passed in all runs; it was not stress-tested.

## Export / import APIs [executed]

| Mode | Export | Import into a fresh handle | Import while a handle is open |
| --- | --- | --- | --- |
| memory | `sqlite3.capi.sqlite3_js_db_export(db)` → `Uint8Array` (16384 B, header `SQLite format 3`) | `sqlite3_deserialize(db.pointer,"main",wasm.allocFromTypedArray(bytes),n,n,FREEONCLOSE\|RESIZEABLE)`. The OO1 db then reports `dbVfsName()` = `memdb`. | Deserialize into the open handle works; the same handle sees the new data. |
| opfs-sahpool | same (or `pool.exportFile(name)`) | `await pool.importDb(name, bytes)`, then `new pool.OpfsSAHPoolDb(name)` | `pool.importDb` on the open file returned 16384, and the open handle then read the imported rows. Upstream does not define this behaviour, so the service closes first. |
| opfs (COI) | same | `await sqlite3.oo1.OpfsDb.importDb(name, bytes)`, then `new OpfsDb(name,"c")` | Same as sahpool: it worked, but it is not relied on. |
| node:sqlite | `VACUUM INTO tmp`, then read the file | file: write the bytes. `:memory:`: ATTACH and replay. | n/a (close then swap) |

`sqlite3_js_vacuum_to_file` is deprecated in the typings in favour of
`sqlite3_js_posix_create_file` / `OpfsDb#importDb`. **[not executed]**

## Static build / Vite [executed]

- Config (`vite.config.ts`):
  - `worker: { format: "es" }`
  - `optimizeDeps: { exclude: ["@sqlite.org/sqlite-wasm"] }`
  - `server/preview.headers` set to COOP/COEP only when `COI=1`
- Worker: `new Worker(new URL("./worker.ts", import.meta.url), { type: "module" })`.
  No `?url` or `?worker` imports are needed.
- The package resolves its own assets with `new URL("sqlite3.wasm", import.meta.url)`
  and `new URL("sqlite3-opfs-async-proxy.js", import.meta.url)`. Vite 8 emits
  both into `dist/assets` (`evidence/vite-build.txt`).
- `dist/assets/sqlite3-worker1-*.js` (212 kB) is also emitted. The deprecated
  Promiser's `new URL(...)` causes it. It is **never requested** at runtime,
  so it is only dead weight.
- `optimizeDeps.exclude` turned out **not to be required** with Vite 8.3.3.
  The dev server with the package pre-bundled still loaded the wasm and ran
  memory, sahpool, and with `COI=1` also opfs and opfs-wl
  (`evidence/vite-dev-noexclude-probe.json`, `evidence/vite-dev-coi-opfs.txt`).
  Keep the exclude anyway, because upstream documents it and it costs nothing.
- Static hosting: a plain server is enough for memory and sahpool. opfs and
  opfs-wl need a host that can send `Cross-Origin-Opener-Policy: same-origin`
  and `Cross-Origin-Embedder-Policy: require-corp`. GitHub Pages cannot send
  these headers, according to the upstream README. That was not tested here.

## Recommended §9 contract revision

```ts
type Persistence = "memory" | "opfs-sahpool" | "opfs";   // "opfs" alone is ambiguous: very different headers/multi-tab
type Cell = null | number | string | bigint | Uint8Array; // in-process/structured-clone form, normalized:
                                                           // integers are number when safe, bigint only when unsafe (both engines)
type JsonCell = null | number | string | { $type: "bigint"; value: string } | { $type: "blob"; base64: string };
// encodeCell(): Cell -> JsonCell is shared by CLI/API/editor JSON output.

type QueryResult = {
  columns: readonly string[];          // first statement with result columns; duplicates allowed
  rows: readonly (readonly Cell[])[];
  changes: number;                     // total_changes() delta (rename affectedRows; never sticky)
  schemaChanged: boolean;              // PRAGMA schema_version moved
  truncated: boolean;
};
type DatabaseError = { _tag: "DatabaseError"; operation: "open" | "execute" | "tables" | "schema" | "reset" | "import" | "export" | "recover"; message: string; cause: unknown };
type DatabaseChange = { kind: "write" | "reset" | "import"; source: "app" | "shell" | "host"; changes: number; schemaChanged: boolean };

interface DatabaseService {
  readonly engine: "sqlite" | "duckdb";
  readonly version: string;                      // sqlite3.version.libVersion / sqlite_version()
  readonly persistence: { requested: Persistence; actual: Persistence; reason?: string }; // visible fallback
  readonly capabilities: { persistence: Capability; export: Capability; import: Capability; cancellation: Capability; multiTab: Capability };
  execute(sql: string, options?: { maxRows?: number; source?: DatabaseChange["source"] }): Effect<QueryResult, DatabaseError>;
  tables(): Effect<readonly string[], DatabaseError>;
  schema(table: string): Effect<string, DatabaseError>;
  reset(): Effect<void, DatabaseError>;
  exportBytes(): Effect<Uint8Array, DatabaseError>;          // SQLite: available everywhere tested
  importBytes(bytes: Uint8Array): Effect<void, DatabaseError>; // header check + quick_check; restores snapshot on failure
  readonly subscribe: Effect<PubSub.Subscription<DatabaseChange>, never, Scope>; // race-free for tests
  readonly changes: Stream<DatabaseChange>;                   // Stream.fromPubSub; publish only after success
}
// Service key: class Database extends Context.Service<Database, DatabaseService>()("prototyper/Database") {}
// Layer: Layer.effect(Database, make(opts)), with Effect.acquireRelease for the handle/worker.
```

Rules to state in §9:

- **Write** means `changes > 0 || schemaChanged`. A no-op UPDATE does not
  publish.
- Reset and import **close before they open**, then swap the handle in a
  `Ref` under the same `Semaphore(1)` that serializes `execute`.
- The default persistence is `opfs-sahpool`, because it needs no headers.
- When the sahpool install fails with `NoModificationAllowedError`, set
  `actual: "memory"`, `reason: "open in another tab"`, `multiTab: unavailable`.
- `opfs` is opt-in and needs COOP/COEP.
- Never detect OPFS with `'opfs' in sqlite3`.

## Open items (not settled by this POC)

- Parameter binding: neither the POC nor its contract has it. `schema()`
  quotes the table name inline.
- Per-statement results: the POC returns only the first result set.
- Events after a partly applied failing multi-statement script.
- Cancellation: neither engine exposes it (`sqlite3_interrupt` is
  **[not executed]**).
- A multi-tab coordinator (Web Locks leader with `pauseVfs` hand-off, using a
  fresh Worker) is **[not executed]**.
- A DB0 shell sharing this worker's handle is out of scope.
