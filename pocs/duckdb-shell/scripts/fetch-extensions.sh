#!/bin/sh
# Self-host the DuckDB extensions the shell/app autoload (json, parquet) so the
# static build works offline. Vite copies public/ into dist/ verbatim.
set -eu
cd "$(dirname "$0")/.."
V=v1.4.3   # DuckDB engine version inside @duckdb/duckdb-wasm@1.32.0
for b in wasm_eh wasm_mvp; do
  mkdir -p "public/duckdb-extensions/$V/$b"
  for e in json parquet; do
    curl -sfL -o "public/duckdb-extensions/$V/$b/$e.duckdb_extension.wasm" \
      "https://extensions.duckdb.org/$V/$b/$e.duckdb_extension.wasm"
  done
done
du -sh public/duckdb-extensions
