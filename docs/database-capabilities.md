# Database capabilities and transfers

Read capabilities from the live `DatabaseService`, and persistence from
`service.persistence.actual` plus `reason`. A requested mode is not proof that
storage succeeded. Main owns the playground controls; R8 supplies the tools.

| Capability             | SQLite browser service                                                         | DuckDB browser service                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| Database export/import | SQLite database image (`.sqlite3`)                                             | Prototyper manifest archive (`.duckdb-export`), schema plus Parquet files; not a native `.duckdb` image |
| Import failure         | Header validation, quick_check; snapshot restored after destructive open fails | Validated manifest/schema/load statements; catalog replacement rolls back on failure                    |
| Table Parquet export   | Unavailable: requires DuckDB                                                   | `COPY "schema"."table" TO ... (FORMAT PARQUET)`; returned bytes are a real Parquet file                 |
| Persistent storage     | `opfs-sahpool`, otherwise memory with reason                                   | `opfs://prototyper-<name>.duckdb`, otherwise memory with reason                                         |
| Write durability       | SAH pool writes                                                                | Service checkpoints committed writes, import and reset; transaction checkpoint waits until COMMIT       |
| Same-file multi-tab    | Unavailable; second tab falls back to memory                                   | Unavailable; second tab falls back to memory                                                            |
| Statement cancellation | Deferred                                                                       | Deferred                                                                                                |
| COOP/COEP required     | No (SAH pool)                                                                  | No (single-worker eh bundle)                                                                            |

Memory is lost on reload. Browser OPFS is origin-scoped local storage, subject
to browser eviction and user deletion; use exports for portable backups.
SQLite's `opfs` mode and DuckDB's `opfs-sahpool` mode are not interchangeable.
Native adapters have their own capabilities; consult the live service rather
than this browser matrix.

## Transfer API

```ts
import { createTransferTools } from "../packages/database/transfer/mod.ts";

const transfer = createTransferTools(service);
const unregister = transfer.registerInterface(async () => {
  // Refresh cached rows/schema or rebind a connection owned by this interface.
  await refreshView();
});
const file = await transfer.exportDatabase(); // { bytes, name, mediaType }
await transfer.importDatabase(file.bytes);
unregister(); // when the interface unmounts
```

Create one controller for each live service. The controller serializes its own
transfers, copies import input before queuing, and enforces import/export
capabilities at execution time. It does not pause independent SQL submissions:
the host must disable writers and finish open transactions before starting a
transfer. Reconnect callbacks must not recursively await another transfer on the
same controller. The host owns file selection, download URLs and their cleanup.

Import delegates to the service's atomic snapshot recovery. It deliberately does
not export and restore a second snapshot outside the service's lock: that could
overwrite concurrent writes. Register every active interface's refresh/rebind
callback. All callbacks run and are awaited after successful import **and after
failed import**, because SQLite recovery can replace its connection without
publishing an import event. Unregister callbacks when disposing an interface.
The DatabaseService object stays stable; existing service-based CLI/API clients
keep their reference. The Fiddle shell retains its worker and DuckDB shells
retain the engine; raw connections/prepared statements and cached views should
refresh through a callback appropriate to their adapter.

`TransferImportError.imported` distinguishes an import that succeeded but failed
to refresh an interface from a failed import. Its `errors` retains the original
import failure plus all reconnect failures. Failed recovery is not hidden or
presented as successful restoration. A capability rejection does not invoke
reconnect callbacks because no import was attempted.

For Parquet, use `transfer.exportParquet({ name: 'table', schema: 'main' })`.
Identifiers are quoted as whole parts (a dot within a name stays a dot);
arbitrary queries and user-supplied output paths are not accepted. Each COPY
uses a unique virtual filename and removes it after copying the bytes. The
DuckDB module is loaded lazily by the common transfer entry, so SQLite-only
transfer controls do not eagerly load DuckDB. Parquet is a table export, not a
database backup.

## DuckDB persistence

```ts
import { duckDbPersistence } from "../packages/database/transfer/duckdb.ts";

// Acquire within the application's Effect scope; close that scope on disposal.
const service = yield* duckDbPersistence({ name: "my-prototype", schema, seed });
```

This helper requests OPFS through the existing DuckDB service. It preserves the
service's fallback status and transaction-aware CHECKPOINT implementation;
initial schema/seed run only on an empty catalog. `fresh: true` is an explicit
destructive test/wipe option and must not be used on normal reload. External
shell writes must use the existing handle's `publishExternal` after commit so
they checkpoint too. Do not issue FORCE CHECKPOINT or checkpoint inside an open
transaction. Actual checkpoint I/O errors propagate; a concurrent writer can
defer checkpoint until its commit.

## Verification and integration

`tests/transfer/` exercises real browser SQLite images (Unicode, NULL, int64,
BLOBs, index and view), corrupt-image snapshot recovery, registered cache
refresh and already-open shells, DuckDB completed real CHECKPOINT SQL followed
by abrupt reload, fallback, and Parquet readback. Unit tests cover capability
refusal, copied Uint8Array and Buffer inputs, queue ordering, unregister during
pending reconnect, independent registration disposal, and reconnect/import
failure reporting. In-memory Vite mutations remove import, snapshot restoration,
checkpoint persistence and reconnect dispatch; `R8_MUTATION=checkpoint_sql`
omits only the actual CHECKPOINT SQL. Each must make its corresponding browser
test fail without editing reference services.

From the repository root:

```sh
/root/.deno/bin/deno test tests/transfer/transfer_test.ts
PW_OUT=/tmp/r8-dev /root/.deno/bin/deno run -A npm:@playwright/test@1.62.0 test --config tests/transfer/playwright.config.ts
/root/.deno/bin/deno run -A npm:vite@8.3.3 build --config tests/transfer/vite.config.ts
PW_TARGET=static PW_DIST=dist-r8 PW_OUT=/tmp/r8-static /root/.deno/bin/deno run -A npm:@playwright/test@1.62.0 test --config tests/transfer/playwright.config.ts
```

Ports are 5198 (dev) and 4198 (static); one browser worker. Main must wire the
playground controls to these APIs, register active interface callbacks, disable
unsupported actions with their reasons, and display actual persistence. The
isolated fixture proves the tool contracts; it does not claim that unwired
playground controls have been tested.
