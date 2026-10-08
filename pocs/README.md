# Proof-of-concept probes

Reference material for `plan.md` §9 and §11, produced on 2026-10-07 by four
Opus 5.5 subagents. Each directory is self-contained (own `deno.json` or
`package.json`, own `node_modules/`, excluded from root `deno fmt`/`deno lint`)
and is **not** part of the toolkit task surface. Read a POC's `README.md`
before writing the brief for the slice that builds on it. Every claim in those
READMEs is marked executed, source-reading, or not executed.

| Directory         | Question                                                                                   | Verdict                                                                                                                                                 | Feeds       |
| ----------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| `sqlite-shell/`   | Can the real upstream `sqlite3` CLI (Fiddle WASM build) be embedded and share a live db?   | **Feasible with the prebuilt Fiddle.** Same WASM instance exports the full C API; app queries run on the shell's own handle both ways; no custom build. | R0, D1, DB0 |
| `sqlite-service/` | App-side SQLite `DatabaseService` in browser + Deno, OPFS modes, Effect 4 service shape.    | **Works.** `opfs-sahpool` needs no headers (single tab); `opfs`/`opfs-wl` need COOP/COEP; `node:sqlite` backs native; shapes match after normalizing.   | D1, R7, R9  |
| `r0-stack/`       | Deno + Vite + React + xterm.js + just-bash + Effect 4.0.2 + fast-check + Playwright.      | **Works.** Playwright runs under Deno directly; just-bash `jq` works in-browser; Effect 4 names recorded.                                               | R0          |
| `duckdb-shell/`   | Embed `@duckdb/duckdb-wasm-shell` on a shared `AsyncDuckDB`; command coverage; OPFS.       | **Embeds and shares both ways.** No `.tables/.schema/.mode/.headers` (Q12); `.open` must be blocked; one shell per page; listeners leak per mount; OPFS needs `CHECKPOINT`; extensions must be self-hosted for offline. | D2, DB1, R8 |

Headline facts the plan now relies on:

- The live Fiddle is SQLite **3.54.0 trunk snapshot** (check-in `4bfc6e53a9`,
  emsdk 5.0.1), vendored under `sqlite-shell/vendor/` with sha256s in
  `PROVENANCE.md`. It is "not an officially-supported deliverable"; never load
  it from sqlite.org at runtime.
- `fiddle-module.js` is the full sqlite3 JS bundle (`sqlite3.capi`,
  `sqlite3.oo1`, `wasm.exports`). The browser SQLite service therefore runs on
  the Fiddle engine; a second sqlite-wasm instance cannot share the live db.
- Fiddle treats each `fiddle_exec` as a complete submission; the host buffers
  lines with the exported `sqlite3_complete` and shows its own continuation
  prompt. Upstream starts the shell with `-bail -safe`; `-safe` makes `.open`
  read-only and blocks OPFS.
- Upstream JS bug: `capi.sqlite3_bind_text` with a JS string throws
  (`pMem is not defined`); bind through `wasm.exports` instead.
- Effect 4.0.2: services are `Context.Service<Self, Shape>()("key")` (no
  `ServiceMap`), layers are curried (`Layer.effect(Tag)(eff)`), recovery is
  `Effect.catch`, errors are `Schema.TaggedError` / `Data.TaggedError`, all
  from the root `"effect"` import.
- Deno `node:sqlite` hazards: `setReadBigInts(true)` or `RangeError` above
  2^53; `prepare()` keeps only the first statement; reading `.sourceSQL` on an
  empty/comment-only statement crashes Deno (exit 139).
- Playwright `@playwright/test@1.62.0` matches the cached `chromium-1234`;
  `deno run -A npm:@playwright/test@1.62.0 test` works without Node.
- Do not use `@deno/vite-plugin`: it resolves just-bash to its Node bundle.
- DuckDB 1.32.0 shell API is `embed({shellModule, container, resolveDatabase,
  backgroundColor?, fontFamily?})`; the shell is a page singleton with no
  dispose; `.open` calls `AsyncDuckDB.open` on the shared instance and destroys
  the app's tables. `toArray()` on Arrow results turns LIST NULLs into 0 and
  drops DECIMAL scale and INTERVAL values. Default `dist` is 81 MB (ship `eh`
  only, ~34 MB raw / ~8 MB gzip).
