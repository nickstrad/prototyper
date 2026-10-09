# Prototyper

A browser toolkit for small applications with a shared database, application
view, command terminal, API explorer, and live SQL editor. SQLite and DuckDB run
locally in WebAssembly. No application server is required for the demos.

## Clean setup

Use Deno 2.9.5 and run from the repository root. On the build VM, first run
`export PATH=/root/.deno/bin:$PATH`.

```sh
deno install --frozen
deno task assets:duckdb
deno task check
deno task test
deno task dev
```

Open <http://127.0.0.1:5173/demos/> for the five-demo gallery or
<http://127.0.0.1:5173/> for the toolkit playground. Initial setup needs network
access to download dependencies and hash-pinned DuckDB assets. The built demos
need only a local asset server; they make no external network requests.

## Build and verify

```sh
deno task test:browser --workers 1
deno task build
deno task serve:static
```

Open <http://127.0.0.1:4173/demos/>. Serve the entire `dist/` directory at the
origin root, including `vendor/`, workers, WASM, and extensions. A plain HTTP
file server works without COOP/COEP headers or API routes. This is offline
operation with assets hosted locally, rather than a service-worker cache for
visiting after the server stops. Demo databases use memory; reload restores seed
rows.

```sh
deno task test:static --workers 1
```

Concurrent runs can select `PW_PORT`, `PW_OUT`, and `PW_DIST`. For example:

```sh
PW_PORT=4313 PW_OUT=test-results-r14 PW_DIST=dist-r14 deno task test:static --workers 1
```

[Demo walkthroughs](demos/README.md), [architecture](docs/architecture.md),
[database capabilities](docs/database-capabilities.md), and
[native adapters](docs/native.md) describe the supported surfaces.

## Generate an application

The generator creates modules against this checkout. It does not emit a
standalone website or register a new host entry. Run this temporary proof:

```sh
proof_dir=$(mktemp -d /tmp/prototyper-proof-XXXXXX)
cat > "$proof_dir/config.json" <<'JSON'
{"name":"second-notes","database":"sqlite","persistence":"memory","interfaces":["cli","api","web"]}
JSON
deno run --allow-read --allow-write="$proof_dir" tools/prototype-new.ts \
  "$proof_dir/config.json" "$proof_dir/second-notes"
deno check --config "$PWD/deno.json" \
  "$proof_dir/second-notes/"*.ts "$proof_dir/second-notes/"*.tsx
deno run --allow-read --config "$PWD/deno.json" "$proof_dir/second-notes/proof.ts"
```

The proof prints `second-notes: SQLite CRUD + SQL passed`. Repeat the generation
command: it must exit 1 and preserve the existing output. Then remove the
scratch directory with `rm -r "$proof_dir"`. See
[the generator guide](docs/new-prototype.md) for all interface selections,
DuckDB configuration, and host integration responsibilities.
