# Real browser database shells — dedicated component plan

Status: **planned; not implemented; both shells proven feasible by executed
probes on 2026-10-07**. `plan.md` owns execution status and model assignments
(§10). Durable progress for these slices lives in `agent-work/items/DB0/` and
`DB1/`. Executed probes live in `pocs/sqlite-shell/` and `pocs/duckdb-shell/`;
read their READMEs before writing a brief.

## Goal

Provide one reusable `DatabaseEditor` React host that runs the actual upstream
SQLite or DuckDB shell inside the browser. The user gets the shell's banner,
prompt, command handling, SQL execution, output and errors, like starting
`sqlite3` or the DuckDB web shell locally. Every prototype mounts that host
against its own live database. Browser execution remains local and requires no
backend.

The host embeds a shell; it does not implement one. Do not write a dot-command
parser, `.mode` formatter, substitute CLI, or custom alias. The shell owns
command interpretation and output. SQLite and DuckDB bindings differ behind the
common host.

## Scope decision (plan.md Q12)

Upstream web shells with a smaller command set than the native CLI are
acceptable. What is not acceptable is closing the gap with toolkit-authored
commands. Concretely:

- **SQLite** required: `.help`, `.tables`, `.schema`, `.mode table`,
  `.mode csv`, `.mode json`, `.headers on|off`, verified against the pinned
  Fiddle build (all executed in the POC). `.schema` is the documented schema
  command; do not invent `.schemas`. Fiddle's `.help` lists 47 commands; the
  file/host commands
  (`.save .backup .restore .read .output .once .import
  .shell .system .load .cd .quit .exit`)
  are compiled out and answer "unknown command" upstream.
- **DuckDB** required: the commands listed by the pinned
  `@duckdb/duckdb-wasm-shell@1.32.0` `.help` (`.clear`, `.help`, `.examples`,
  `.features`, `.output on|off`, `.timer on|off`, `.open`, `.files ...`), plus
  the SQL equivalents `SHOW TABLES` and `DESCRIBE <table>` (`SUMMARIZE`,
  `duckdb_tables()`, `to_json`, `COPY ... (FORMAT csv)` also work). The shell
  has one fixed box-table output format; `.mode`, `.tables`, `.schema` and
  `.headers` print `Unknown command`; `.reset` prints "Not implemented yet".
  Record the real `.help` output as evidence.

Commands the shell lacks are shown with the shell's own response. The host
**blocks `.open`** on both engines (see below). Reset is a host control that
goes through the shared `DatabaseService` and republishes change notifications.

## Upstream execution targets and evidence

- **SQLite:** the upstream `sqlite3` CLI compiled to WebAssembly exists only as
  the Fiddle build (`ext/wasm`, `make fiddle`, requires a full SQLite source
  tree and the Emscripten SDK). The `sqlite-wasm` download zip does not include
  it, and `emcc` is not installed on the development machine. DB0 therefore
  starts from `pocs/sqlite-shell`: vendored Fiddle artifacts (SQLite 3.54.0
  trunk snapshot `4bfc6e53a9`, emsdk 5.0.1) with `PROVENANCE.md`. **Proven:**
  `fiddle-module.js` is the full sqlite3 JS bundle; the same WASM instance
  exports `fiddle_exec`, `fiddle_db_handle`, `fiddle_reset_db`,
  `fiddle_export_db`, `fiddle_interrupt`, `fiddle_get_prompt` and 214
  `sqlite3_*` functions, so structured app queries run on the shell's own
  connection. Upstream starts it with `-bail -safe`; plan.md Q17 drops both.
  Fiddle is "not an officially-supported deliverable": vendor it, never load it
  from sqlite.org at runtime.
- **DuckDB:** `@duckdb/duckdb-wasm-shell` is a Rust→WASM shell rendering into
  xterm.js, embedded with
  `embed({ shellModule, container, resolveDatabase,
  backgroundColor?, fontFamily? })`,
  where `resolveDatabase` returns an existing `AsyncDuckDB`. **Proven:** the
  shell opens its own connection (`connectInternal`) on that instance; app
  writes appear in the shell and shell writes (including DDL) appear in the app,
  with normal connection isolation (an uncommitted shell `BEGIN` hides rows; an
  app `UPDATE` on a shell-locked row fails with `Conflict on update!`). The
  shell is a page-global singleton with no dispose API; a second `embed` hijacks
  the first terminal, and each mount leaks listeners. Pin
  `@duckdb/duckdb-wasm@1.32.0` and `@duckdb/duckdb-wasm-shell@1.32.0` (engine
  1.4.3); `latest` has an OPFS regression.

## One common host, engine-specific bindings

```text
packages/database-editor/
  DatabaseEditor.tsx       common lifecycle, layout, shell mount and host controls
  types.ts                shell binding contract (plan.md §9 ShellBinding)
  sqlite-shell.ts         upstream sqlite3 (Fiddle) binding: shell message family, input buffering
  duckdb-shell.ts         upstream DuckDB web shell binding: embed-once, .open guard, cleanup
packages/database/
  worker*.ts              R0 engine-worker skeleton: loads the vendored Fiddle module, §9 protocol
  sqlite*.ts              D1 app-side service (exec family on the Fiddle engine; node:sqlite natively)
  duckdb*.ts              D2 app-side service (AsyncDuckDB)
  conformance*.ts         D1 suite run against every DatabaseService implementation
```

The common host mounts the selected upstream shell once per prototype instance,
passes keyboard input or script submissions through its supported interface,
displays actual shell output, and handles focus, resize and disposal. Reuse the
upstream terminal renderer or a shared xterm.js surface as its embedding API
permits. Do not re-render SQL output in a custom way that makes `.mode`
ineffective. Host controls (table list, schema, reset, capability-gated
import/export) operate on the same `DatabaseService`; they are auxiliary to the
real console.

The application terminal still uses just-bash for application commands. The
Database view runs the engine's upstream shell. Do not confuse the two command
interpreters or implement a new generic shell to connect them.

## Critical integration contract: the prototype's live database

The console and application must share the same database, not two seeded copies
or periodically synchronized snapshots. Both mechanisms are proven; DB0/DB1
implement them and R4 verifies them across every interface:

1. **DuckDB (proven):** D2's service owns the `AsyncDuckDB`; the shell gets it
   through `resolveDatabase` and holds its own connection. The host wraps
   `AsyncDuckDB.open` so the shell's `.open` cannot replace the database
   (unwrapped, it drops the app's tables and leaves the app connection throwing
   `Max expression depth limit of 0 exceeded`). Embed once per prototype
   instance and move the container between tabs; remove listeners on dispose;
   `db.terminate()` frees the worker. Keys typed while a statement runs are
   dropped upstream; every keystroke sends a TOKENIZE request, so the shell must
   never outlive its database.
2. **SQLite (proven bridge):** one WASM instance; R0's engine worker loads the
   vendored Fiddle module. The `shell` message family drives `fiddle_exec`; the
   `exec` family runs structured queries on `fiddle_db_handle()` through
   `sqlite3.capi` / `oo1.DB.wrapHandle`. There is one connection and no
   isolation: an app read sees the shell's uncommitted `BEGIN`. The app never
   parses shell text. `sqlite3_update_hook` on that handle reports shell writes;
   `fiddle_reset_db` and `sqlite3_deserialize` keep the same handle. The shell's
   `.open` replaces the connection (visible through `fiddle_db_handle`) and is
   blocked by the host. Input plumbing the binding must provide: buffer typed
   lines until the exported `sqlite3_complete` accepts them, show a fixed
   continuation prompt (`fiddle_get_prompt` returns only the main prompt), and
   suppress the duplicate echo of dot commands. The shared-OPFS alternative (two
   instances on the `opfs` VFS under COOP/COEP) is no longer needed.
3. Preserve the shell's settings independently of structured application
   queries. Changing `.mode` must not affect application query decoding (proven
   for SQLite).
4. Reset/import must retain the live instance and publish change notifications.
   DuckDB has no update hook; after any console submission that did not error,
   publish a conservative `write` with a catalog diff for `schemaChanged`.
5. The final public binding contract is plan.md §9 `ShellBinding`. Effect Layers
   own the runtime/resources. The host must not start an unrelated engine on
   every render or tab change.

Browser filesystem and subprocess limitations must be documented from actual
execution. Preserve upstream unsupported-command behavior where available.

## Two dedicated vertical slices

| ID  | Wave | Depends on | Build (Claude / Codex)   | Review (Claude / Codex)      | Observable finish                                                                                                                                                                                                                                                    |
| --- | ---- | ---------- | ------------------------ | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DB0 | 1–3  | R0         | Fable 5.1 / sol 6.1 high | Fable 5.1 / sol 6.1 high     | Common host runs the real sqlite3 shell against a seeded prototype database. Required SQLite commands and SQL work with recorded output; app and console share live data both ways; `.open` blocked; multiline/`;`/error-then-valid pass; no custom parser.          |
| DB1 | 4    | DB0, D2    | Opus 5.5 / sol 6.1 high  | Opus 5.5 high / sol 6.1 high | Real upstream DuckDB shell in the same host over D2's instance. Q12 command set and SQL walkthrough executed; sharing proven both ways; `.open` blocked; six mount cycles leak nothing; SQLite regressions pass. Escalate to Fable if the host contract must change. |

DB0 owns `packages/database-editor/`, `packages/database/sqlite-shell*` and
`tests/database-editor/`. R0 (main) owns the vendored shell assets, the engine
worker skeleton, dependency versions, build configuration and public contract
approval. DB1 owns `packages/database-editor/duckdb-shell.ts` and
`tests/database-editor-duckdb/`; edits to the common host require a dedicated
claim and SQLite regression review.

DB0 runs concurrently with D1 (wave 1) on R0's worker and continues alongside
R1–R3; R1 does not wait for it. R4 is the first slice that verifies editor
writes across every interface. R6 adds the analytical application using D2 and
DB1. Generators and demos mount this same host rather than copying editors. R8
completes transfer controls using capabilities actually exposed by the selected
upstream builds.

## Verification

Execute the following in a real browser against both upstream shells, not mocks,
and save the real output under the item's evidence directory:

```text
.help
.tables                      (SQLite)   | SHOW TABLES;        (DuckDB)
.schema                      (SQLite)   | DESCRIBE <table>;   (DuckDB)
.mode table / .headers on    (SQLite only)
SELECT * FROM <seeded_table>;
.mode csv  + SELECT ...      (SQLite only)
.mode json + SELECT ...      (SQLite only)
.timer on                    (DuckDB)
.open :memory:               (both: expect the host's block message)
```

Also verify a multiline SQL statement, strings containing semicolons, an error
followed by a valid command, unsupported commands (capture the shell's own
message), and session settings across tab changes. Do not implement SQL
splitting to mimic these behaviors; use upstream execution (`sqlite3_complete`
is the upstream completeness check, not a splitter).

Create/update/delete data through the shell and another enabled interface, then
query through both to prove shared database identity. Verify resets, nullable
and engine-specific result types, workers/listeners on close/reopen, and static
WASM/worker assets served without special headers. Every generated prototype and
final demo must have a Database view mounting the same component with its
selected engine binding.

Keep source version, upstream build provenance, required browser headers, shell
command coverage, evidence, pending blockers and exact recovery steps in the
global progress records. Do not mark either engine supported without executed
proof.
