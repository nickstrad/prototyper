# SQLite persistence

`sqlitePersistence({ schema, seed })` acquires the existing Fiddle-backed
`DatabaseService` in an Effect scope, requesting only `opfs-sahpool`. Keep that
scope alive while using the service and close it when the host unmounts. Closing
releases the worker and its pool locks. First-open initialization uses the D1
service's `user_version` marker; it does not reset an existing database.
`service.reset()` restores the supplied schema and seed in the same persisted
file.

Render `<SqlitePersistenceStatus persistence={service.persistence} />` after
acquisition. It displays the actual backend and preserves the engine's fallback
reason. A tab that cannot acquire the pool gets a separate memory database. Its
writes disappear on reload and are never merged into persistent storage. Close
the owning tab, then reload the fallback tab to retry.

The existing adapter owns the default origin-wide pool and `/fiddle.sqlite3`
filename. This composition does not add per-prototype namespaces or multi-tab
writers. The shell and service must share the same worker if mounted together;
do not open an independent shell first, since persistence must be configured
before the shell's lazy database open. Headered VFS modes remain deferred.

The inherited worker uses the Q17 argv (`/fiddle.sqlite3`, without `-safe` or
`-bail`) and supplies the vendor directory through `locateFile`. This checkout
loads SAH-pool successfully without a `sqlite3.dir` worker URL parameter in both
dev and built static output. No shared loader/adapter change is part of R7.

The standalone fixture at `/tests/persistence/sqlite/index.html` exercises the
component and the real service without a playground mount. Build it with:

```sh
/root/.deno/bin/deno run -A npm:vite@8.3.3 build --config tests/persistence/sqlite/vite.config.ts --outDir dist-r7
```

Run its browser suite with one worker and the assigned port/output directory:

```sh
PATH=/root/.deno/bin:$PATH PW_PORT=5196 PW_OUT=test-results-r7-dev PW_DIST=dist-r7 /root/.deno/bin/deno run -A npm:@playwright/test@1.62.0 test tests/persistence/sqlite/ --workers 1
PATH=/root/.deno/bin:$PATH PW_TARGET=static PW_PORT=4196 PW_OUT=test-results-r7-static PW_DIST=dist-r7 /root/.deno/bin/deno run -A npm:@playwright/test@1.62.0 test tests/persistence/sqlite/ --workers 1
```
