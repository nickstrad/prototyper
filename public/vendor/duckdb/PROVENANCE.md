# public/vendor/duckdb — provenance (D2)

Everything here except this file is ignored by git and is produced by

    deno run -A scripts/fetch-duckdb-extensions.ts          # populate + verify
    deno run -A scripts/fetch-duckdb-extensions.ts --check  # verify only

Run it before `vite build` or any browser test that touches DuckDB. The script
compares every file with the size and sha256 below (pinned in the script) and
leaves matching files alone, so a second run needs no network. The DuckDB
service loads these from the page's own origin only; nothing is fetched from a
CDN at runtime, and no COOP/COEP headers are needed (`eh` bundle).

| Path                                                     | Bytes      | sha256                                                             | Source                                                                                      |
| -------------------------------------------------------- | ---------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `duckdb-eh.wasm`                                         | 34,242,586 | `4c221bfa59c11f24dbd750e70c90b9252eca6eec5633936e6a2ec766e55fd879` | `node_modules/@duckdb/duckdb-wasm/dist/` (npm `@duckdb/duckdb-wasm@1.32.0`, `deno.lock`)    |
| `duckdb-browser-eh.worker.js`                            | 772,759    | `f8ab72b6b90b3ad83077d47426d4a99d5d9a4c7e07cba1a2be37d655adc7c1ab` | same package                                                                                |
| `extensions/v1.4.3/wasm_eh/json.duckdb_extension.wasm`   | 820,646    | `b997276c8e15cc3ebdeda340d73d15dc1c4f4755ad281280451cb0a2f79302e9` | `https://extensions.duckdb.org/v1.4.3/wasm_eh/json.duckdb_extension.wasm` (Last-Modified 2025-12-08 13:52:57 GMT)    |
| `extensions/v1.4.3/wasm_eh/parquet.duckdb_extension.wasm`| 3,045,039  | `22765c8f7dc741cda2b571a66ac7bb355295d7d69a6c37e5315b265672984f55` | `https://extensions.duckdb.org/v1.4.3/wasm_eh/parquet.duckdb_extension.wasm` (Last-Modified 2025-12-08 13:53:05 GMT) |

- Engine: DuckDB v1.4.3 inside `@duckdb/duckdb-wasm@1.32.0` (never npm `latest`).
- Only the `eh` bundle ships (plan.md Q18); `mvp` and `coi` are not copied.
- Extensions are the official signed builds; the service sets
  `custom_extension_repository = '<origin><base>vendor/duckdb/extensions'`, so
  autoloading `json`/`parquet` resolves to the files above. Other extensions
  (e.g. `icu`, `httpfs`) are not shipped and fail to load offline.
- Fetched 2026-10-08 by the D2 builder (run-20261008-d2-01).
