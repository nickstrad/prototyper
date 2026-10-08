# Generate a prototype

The generator emits a small notes application against this checkout's current
DatabaseService, Effect, just-bash, fetch router, and React conventions. It
never edits the prototype registry or root configuration. The host supplies the
Database editor for every prototype, including those with no optional
interfaces.

## Config

Supply a JSON object matching `packages/core/types.ts`'s `PrototypeConfig`:

```json
{
  "name": "second-notes",
  "database": "sqlite",
  "persistence": "memory",
  "interfaces": ["cli", "api", "web"]
}
```

- `name`: lowercase slug, starting with a letter, 1–64 characters.
- `database`: `sqlite` or `duckdb`; required, never omitted.
- `persistence`: `memory` for either engine, `opfs-sahpool` for SQLite, or
  `opfs` for DuckDB. The browser service reports any persistence fallback.
- `interfaces`: unique array drawn from `cli`, `api`, `web`. A single entry
  selects that interface, multiple entries select a combined prototype, and `[]`
  selects Database alone. Output normalizes ordering to CLI, API, web.

All fields are required; unknown fields and invalid combinations are rejected
before creating output. There are no timestamps, random seeds, or dependency
changes. Identical configs at equivalent directory depth produce identical
bytes. Relative package imports depend on the output location.

## Run and prove in a temporary directory

From the toolkit root, with Deno 2.9.5 (on this VM, use `/root/.deno/bin/deno`):

```sh
proof_dir=$(mktemp -d /tmp/r5-proof-XXXXXX)
cat > "$proof_dir/config.json" <<'JSON'
{"name":"second-notes","database":"sqlite","persistence":"memory","interfaces":["cli","api","web"]}
JSON
/root/.deno/bin/deno run --allow-read --allow-write="$proof_dir" \
  tools/prototype-new.ts "$proof_dir/config.json" "$proof_dir/second-notes"
/root/.deno/bin/deno check --config "$PWD/deno.json" \
  "$proof_dir/second-notes/"*.ts "$proof_dir/second-notes/"*.tsx
/root/.deno/bin/deno run --allow-read --config "$PWD/deno.json" \
  "$proof_dir/second-notes/proof.ts"
```

The last command must print `second-notes: SQLite CRUD + SQL passed`. It runs
create, read, update, delete, and raw SQL against D1's real DatabaseService with
its native SQLite backend, then disposes the runtime. It uses memory regardless
of browser persistence config. This is an executable native build/check proof;
it does not run a Vite production build or a browser visual smoke test.

Repeat the generator command with the same destination: it must exit 1, leaving
all existing contents unchanged. Even an empty directory, file, or symlink is
refused. The parent directory must already exist; there is no force option.
Remove the temporary directory when finished:

```sh
rm -r "$proof_dir"
```

Programmatic usage: import `generatePrototype(config, destination)` from
`tools/prototype-new.ts`; it returns the sorted emitted filenames.
`parseConfig(unknown)` validates and normalizes a config. Templates live under
`templates/prototype/`; `.tmpl` files are source text, checked by generating and
type-checking the resulting modules.

## Generated modules and host integration

Every output has `config.ts`, `schema.ts`, `application.ts`, `database.ts`, and
`README.md`. The notes application exposes list, put (create/update), and delete
Effects over the shared Database service. IDs and bodies are decoded from
unknown inputs with Effect Schema v4 and schema failures become tagged
`InvalidInput` errors. Both must be nonblank, at most 1,000 UTF-16 code units,
without NUL or lone surrogates. Valid text is preserved (including surrounding
whitespace) and quoted as SQL text. Explicit text IDs work with both engines
without auto-ID dialect assumptions. Schema and deterministic seed are applied
by the service.

`listNotes()` returns an array only when the full result fits the database row
limit (1,000 by default). A truncated query fails with tagged `ListTooLarge`;
the CLI returns nonzero with the error message, the API returns HTTP 500 with
the error tag/message, and the web view displays an alert. Use the Database
editor to issue a narrower query when this example outgrows that limit.

| Selection | Additional module       | Host entry point                                                        |
| --------- | ----------------------- | ----------------------------------------------------------------------- |
| CLI       | `commands.ts`           | `commands(runtime)`: notes commands plus standard `db` commands         |
| API       | `api.ts`                | `createApi(runtime)`: GET `/notes`, PUT/DELETE `/notes/:id`             |
| Web       | `App.tsx`               | `App({ runtime })`: list and save notes, subscribed to database changes |
| SQLite    | `native.ts`, `proof.ts` | `nativeLayer()`, `prove()` for native memory proof                      |

`databaseLayer()` builds the browser engine layer. The host should acquire it
once per prototype instance and supply the same Database service to every
adapter and the existing Database editor. Dispose the owning scope/runtime on
close. The web component interrupts its subscription on unmount; it does not own
the host runtime. `config.ts` exports `panels`, starting with `database`
regardless of optional interfaces.

DuckDB generation is enabled and selects the landed D2 service. Its CLI/API
adapters run in-process in the browser host; this does not add a native DuckDB
adapter. Serve the existing vendored DuckDB assets and extensions at the
service's normal base URL. SQLite likewise uses the existing browser
worker/assets. No standalone web entry page, server socket, Vite config, asset
copy, or registry registration is generated. Imports point back to this
checkout; regenerate after moving the output to another layout. Browser hosting
and native transport remain host responsibilities.

Requested integration for main: add a `prototype:new` task invoking
`deno run --allow-read --allow-write tools/prototype-new.ts`, and wire generated
config/modules into the host registry while always mounting Database. Neither
shared file is changed by R5.

## Regression tests

```sh
/root/.deno/bin/deno test --allow-read --allow-write=/tmp tests/generator/
/root/.deno/bin/deno task test
```

Tests generate only under `/tmp` and clean up. They cover all eight interface
subsets for each engine, mandatory Database files/panel, engine selection,
determinism, strict config validation, existing-path preservation,
API/application/SQL sharing, accepted/rejected input boundaries through shared
operations, unchanged data after invalid mutations, explicit over-limit failure
in the core/API, and execution of the generated SQLite CRUD/SQL proof. The
attempt evidence records intentional mutations to interface selection, Database
inclusion, and overwrite refusal; each must make its corresponding tests fail
before restoring the source.

Symlink refusal has a separate proof because Deno 2.9.5 cannot create symlinks
with the root task's scoped write grant. It creates and removes only its own
temporary directory:

```sh
/root/.deno/bin/deno run --allow-read --allow-write tests/generator/symlink-proof.ts
```
