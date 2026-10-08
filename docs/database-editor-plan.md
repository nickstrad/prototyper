# Real browser database shells — dedicated component plan

Status: **planned; not implemented**. `plan.md` owns execution status. Durable
progress for these slices lives in `agent-work/items/DB0/` and `DB1/`.

## Goal

Provide one reusable `DatabaseEditor` React host that runs the actual upstream
SQLite or DuckDB shell inside the browser. The user gets the shell's banner,
prompt, command handling, SQL execution, output modes and errors, like starting
`sqlite3` or `duckdb` in a local terminal. Every prototype mounts that host
against its own live database. Browser execution remains local and requires no
backend.

The host embeds a shell; it does not implement one. Do not write a dot-command
parser, `.mode` formatter, substitute CLI, or custom `.schemas` alias. The shell
itself owns command interpretation, continuation prompts and output. SQLite and
DuckDB bindings differ behind the common host.

## Upstream execution targets and evidence

- **SQLite:** execute the upstream `sqlite3` CLI compiled to WebAssembly.
  [SQLite Fiddle](https://sqlite.org/fiddle/index.html) demonstrates a browser
  wrapper around that CLI. Inspect its source/build and browser adaptations;
  investigate whether a maintained distributable can be embedded or whether a
  reproducible upstream build is needed. Fiddle is evidence of feasibility, not
  proof of a stable embedding API.
- **DuckDB:** require upstream shell execution over the actual DuckDB engine.
  Investigate the official
  [DuckDB WASM shell package](https://github.com/duckdb/duckdb-wasm/tree/main/packages/duckdb-wasm-shell)
  and a browser build of the native CLI where necessary. The upstream repository
  identifies its web shell as Rust; do not describe it as the same native CLI
  executable or assume all native commands are present. Verify its exact command
  set against the requested terminal experience. A shell that lacks required
  commands does not pass DB1 merely because SQL works.

Required familiar commands include `.help`, `.tables`, `.schema`, `.mode`,
`.mode table`, `.mode csv`, `.mode json`, and `.headers on|off`, as supported by
and verified against the chosen upstream CLI version. Reference the real
[SQLite CLI](https://sqlite.org/cli.html) and
[DuckDB dot-command documentation](https://duckdb.org/docs/current/clients/cli/dot_commands).
`.schemas` was an example in the request: inspect upstream `.help` and expose
real commands; `.schema` is the documented schema command. Do not invent an
alias to make the console appear native.

If the available DuckDB web shell cannot deliver the required behavior,
investigate an upstream native-shell WASM build. If that or live database
sharing cannot be established, record the blocker and evidence and leave DB1
incomplete. Do not silently replace the shell with toolkit-authored command
handlers or a hosted iframe. Changing that requirement requires an explicit
scope decision.

## One common host, engine-specific bindings

Planned organization:

```text
packages/database-editor/
  DatabaseEditor.tsx       common lifecycle, layout, shell mount and host controls
  types.ts                shell binding contract
  sqlite-shell.ts         upstream sqlite3 WASM shell binding
  duckdb-shell.ts         upstream DuckDB shell binding
```

The common host mounts the selected upstream shell, passes keyboard input or
script submissions through its supported interface, displays actual shell
output, and handles focus, resize and disposal. Reuse the upstream terminal
renderer or a shared xterm.js surface as its embedding API permits. Do not
re-render SQL output in a custom way that makes `.mode` ineffective. Optional
schema/navigation or reset/import/export controls must operate on the same
runtime; they are auxiliary to the real console.

The application terminal still uses just-bash for application commands. The
Database view runs the engine's upstream shell. Do not confuse the two command
interpreters or implement a new generic shell to connect them.

## Critical integration contract: the prototype's live database

The console and application must share the same database, not two independently
seeded copies or periodically synchronized snapshots. Resolve this in DB0/DB1
before downstream prototypes use the engine:

1. Prefer upstream shell APIs that can attach to an existing engine instance.
2. If the shell must own the engine, bind the application database service to
   that shell-owned runtime using verified upstream APIs or a narrow native
   bridge. A bridge exposes engine access and I/O; it does not remake commands.
3. Verify both directions: application write appears in shell SQL; shell write
   appears in UI/CLI/API. Test the selected connection/concurrency semantics.
4. Preserve the shell's settings independently of structured application
   queries. Changing `.mode` must not break application query decoding. Do not
   build domain logic around parsing human-readable CLI output.
5. Reset/import/open behavior must retain or explicitly rebind the live
   instance. Opening another database must be handled explicitly, not silently
   detach the console from the prototype. Publish shared change notifications
   after writes.

The final public binding contract is established by executed probes, not
invented here. It must describe mounting, input, upstream output, readiness,
database identity, structured engine access, supported cancellation and
disposal. Effect Layers own the runtime/resources. The common component must not
start an unrelated engine on every render or tab change.

Browser filesystem and subprocess limitations must be documented from actual
execution. Do not pretend the browser offers the desktop host's filesystem or
system shell. Preserve upstream unsupported-command behavior where available.

## Two dedicated vertical slices

| ID  | Depends on | Owner                                                                                          | Reviewed by                     | Observable finish                                                                                                                                                                                                   |
| --- | ---------- | ---------------------------------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DB0 | R0         | builder-strong (opus medium / sol medium — upstream CLI embedding and live-engine integration) | reviewer (opus high / sol high) | Common DatabaseEditor host runs real upstream sqlite3 WASM CLI against a seeded prototype database. Prompt, `.help`, schema/output-mode commands and SQL work; application and console share live data.             |
| DB1 | DB0        | builder-strong (opus medium / sol medium — upstream DuckDB shell and worker integration)       | reviewer (opus high / sol high) | Add real upstream DuckDB shell to the same host. Execute the required command walkthrough and prove live database sharing. Native/web-shell differences are evidenced; unmet requirements keep the item incomplete. |

DB0 owns `packages/database-editor/`, SQLite binding/service files and
`tests/database-editor/`. Main owns dependency versions, build configuration,
public contract approval and the seeded test-workbench mount. DB1 owns the
DuckDB binding/service and `tests/database-editor-duckdb/`; edits to the common
host require a dedicated claim and SQLite regression review.

After DB0, R1 (task application) and DB1 can proceed in parallel on disjoint
files. R6 adds the analytical application using DB1. Generators and demos mount
this same host rather than copying editors. R8 completes transfer controls using
capabilities actually exposed by the selected upstream builds.

## Verification

Execute the following in a real browser against both upstream shells, not mocks:

```text
.help
.tables
.schema
.mode table
.headers on
SELECT * FROM <seeded_table>;
.mode csv
SELECT * FROM <seeded_table>;
.mode json
SELECT * FROM <seeded_table>;
```

Record real output and compare the required behavior with the pinned upstream
shell. Verify a multiline SQL statement, strings containing semicolons, errors
followed by a valid command, and session settings across tab changes. Do not
implement SQL splitting to mimic these behaviors; use upstream execution.

Create/update/delete data through the shell and another enabled interface, then
query through both to prove shared database identity. Verify resets, nullable
and engine-specific result types, supported file operations, workers/listeners
on close/reopen, and static WASM/worker assets. Test unsupported commands
honestly. Every generated prototype and final demo must have a Database view
mounting the same component with its selected engine binding.

Use R0's task surface and exact acceptance filters from each brief. Keep source
version, upstream build provenance, required browser headers, shell command
coverage, evidence, pending blockers and exact recovery steps in the global
progress records. Do not mark either engine supported without executed proof.
