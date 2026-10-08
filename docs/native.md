# Native Deno adapters

`adapters/deno/mod.ts` creates a native task host using D1's `node:sqlite`
DatabaseService. One host owns one scoped runtime and database service. Its task
CLI, database CLI, and fetch API use that runtime. `serveNativeHost(host)` adds
a `Deno.serve` transport to the existing host; it never opens another database.

Requires Deno 2.9.5. On this droplet use `/root/.deno/bin/deno`.

```sh
/root/.deno/bin/deno run --allow-read --allow-write=/tmp \
  adapters/deno/main.ts --database /tmp/tasks.sqlite tasks create "Ship R9"
/root/.deno/bin/deno run --allow-read --allow-write=/tmp \
  adapters/deno/main.ts --database /tmp/tasks.sqlite tasks list --json
/root/.deno/bin/deno run --allow-read --allow-net=127.0.0.1:5197 \
  adapters/deno/main.ts serve --port 5197 --stdio
```

The last command accepts one JSON argv array per stdin line, for example
`["tasks","create","--json","Shared with HTTP"]`. It prints a JSON
`{stdout,stderr,exitCode}` per line. While it runs,
`GET http://127.0.0.1:5197/tasks` sees the same in-memory database. HTTP updates
are immediately visible to subsequent stdin commands. Invalid JSON/argv produces
exitCode 2 for that line; EOF drains the server and disposes the host. SIGINT
and SIGTERM shut down either server mode, including while stdin is idle.

Without `--stdio`, `serve` runs until signalled. Binding defaults to loopback
port 5197; `--port` selects another valid TCP port. `--database PATH` must
precede the mode and defaults to `:memory:`. A one-shot CLI process disposes its
host when the command finishes. Separate processes with the same file retain
data but do not share a live service; use `serve --stdio` or embed one host for
simultaneous CLI and HTTP access. The native file behavior is D1's existing
implementation.

Task commands reuse R2's `tasks list|get|create|complete|update|delete`;
`--json`, validation, stdout/stderr, and exit codes are unchanged.
`db
info|tables|schema|sql|reset` likewise reuse R2. One-shot `db sql` with no
SQL arguments reads stdin. Stdio server commands carry SQL as an argv element.
Expected failures exit 1, usage errors exit 2, and successful commands exit 0.
Startup failures exit 1. There is no shell parsing in JSON argv mode.

The API reuses the task-manager fetch handler:

| Method | Route                  | Operation                                    |
| ------ | ---------------------- | -------------------------------------------- |
| GET    | `/tasks`, `/tasks/:id` | List/get                                     |
| POST   | `/tasks`               | Create with `{title}`                        |
| PATCH  | `/tasks/:id`           | Update with `{title?, completed?}`           |
| DELETE | `/tasks/:id`           | Delete                                       |
| POST   | `/tasks/:id/complete`  | Complete                                     |
| POST   | `/reset`               | Restore seed                                 |
| POST   | `/sql`                 | Opt-in SQL inspection with `{sql, maxRows?}` |

`/sql` is absent unless `--sql` (or `{sql: true}`) is supplied. This executes
arbitrary SQL and is for trusted local callers, as in the existing browser API.
The adapter adds no authentication. Application error mappings are unchanged:
InvalidInput 400, TaskNotFound 404, CorruptTask/DatabaseError 500. The
inspection route maps SQL failures to 400 SqlError. Bigint/blob cells use the
shared tagged JSON cell encoding. Engine diagnostic text remains the original
backend's text.

Embedding:

```ts
import { createNativeHost, serveNativeHost } from "../adapters/deno/mod.ts";

const host = await createNativeHost();
try {
  const server = serveNativeHost(host, { port: 5197 });
  try {
    await host.command(["tasks", "create", "Shared"]);
    // HTTP requests and host.fetch(Request) see the same task.
    await server.finished;
  } finally {
    await server.shutdown();
  }
} finally {
  await host.dispose();
}
```

A caller owns host disposal; shut down/drain HTTP first. Importing `main.ts` has
no listener or database side effects. Native consumers import `mod.ts`; browser
consumers retain their existing `sqlite-browser.ts` + task
application/commands/API imports. There is no combined barrel that pulls
`node:sqlite` into browser code.

Verification (from repository root):

```sh
/root/.deno/bin/deno fmt --check adapters/deno tests/native docs/native.md
/root/.deno/bin/deno lint
/root/.deno/bin/deno check
/root/.deno/bin/deno task test
/root/.deno/bin/deno run --allow-read --allow-write=/tmp --allow-run --allow-net=127.0.0.1:5197 tests/native/transport.ts
PATH=/root/.deno/bin:$PATH PW_PORT=5197 PW_OUT=test-results-r9 PW_DIST=dist-r9 \
  /root/.deno/bin/deno run -A npm:@playwright/test@1.62.0 test tests/native/equivalence.spec.ts --workers 1
/root/.deno/bin/deno run -A npm:vite@8.3.3 build --config tests/native/vite.config.ts --outDir dist-r9
PATH=/root/.deno/bin:$PATH PW_TARGET=static PW_PORT=4197 PW_OUT=test-results-r9-static PW_DIST=dist-r9 \
  /root/.deno/bin/deno run -A npm:@playwright/test@1.62.0 test tests/native/equivalence.spec.ts --workers 1
```

The browser fixture runs D1's real Fiddle SQLite worker against the native
transcript with a fixed application clock. It checks mixed CLI/API operations,
validation and application failures, SQL failures and partial writes. Import
graph tests and the isolated production build guard platform separation. The
explicit transport probe verifies the executable and actual TCP; it needs
permissions outside the default unit-test task. Mutation evidence belongs to the
R9 attempt record under `agent-work/items/R9/attempts/run-20261008-r9-01/`.
