# Integrations (R0 baseline)

What R0 wired together, with the exact versions, the headers the static build
needs, what the bundle contains, and the assumptions later slices must not make.
Everything here was executed on 2026-10-08 (Deno 2.9.5, Chromium 1234 via
Playwright 1.62.0, Ubuntu 24.04) unless marked **not executed**. Evidence lives
in `agent-work/items/R0/attempts/run-20261007-r0-01/evidence/`.

## Task surface (`deno.json`)

| Task               | Command                                                                | Verified                                  |
| ------------------ | ---------------------------------------------------------------------- | ----------------------------------------- |
| `dev`              | `vite` on 127.0.0.1:5173 (strict port)                                 | used by `test:browser`                    |
| `build`            | `vite build` → `dist/`                                                 | exit 0, `evidence/build-output.txt`       |
| `serve:static`     | `jsr:@std/http@1.0.19/file-server dist` on 127.0.0.1:4173, no headers  | used by `test:static`                     |
| `check`            | `deno fmt --check && deno lint && deno check`                          | exit 0, `evidence/task-check.txt`         |
| `test`             | `deno test --allow-env=PROTOTYPER_REPLAY_PATH` (whole repo, see below) | 8 passed, `evidence/task-test.txt`        |
| `test:browser`     | `deno run -A npm:@playwright/test@1.62.0 test` against the dev server  | 2 passed, `evidence/test-browser-dev.txt` |
| `test:browser:npx` | `npx playwright test` (documented fallback)                            | **not executed**                          |
| `test:static`      | `deno task build && PW_TARGET=static <playwright>`                     | 2 passed, `evidence/test-static.txt`      |
| `start`            | Hello World `main.ts` (baseline; kept so README stays true)            | unchanged                                 |

`deno test` runs with no path argument so new slices are discovered
automatically; the `exclude` list (`dist`, `node_modules`, `test-results`,
`playwright-report`, `pocs`, `public/vendor`) is the only filter and it also
scopes `fmt`, `lint` and `check`. Playwright specs end in `.spec.ts`, which
`deno test` does not pick up; `deno check` still type-checks them. Markdown
under `agent-work/` and `docs/` is formatted by `deno fmt`.

## Pinned versions (Q13; all in `deno.lock`)

| Package                     | Version                                | Note                                                                                                                                          |
| --------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| effect                      | 4.0.2                                  | Published 2026-10-07T18:21Z. Deno's default 24 h minimum-dependency-age policy refused it on 2026-10-08; see "Lockfile" below.                |
| just-bash                   | 3.6.0                                  | Browser bundle `dist/bundle/browser.js` (selected by the `browser` export condition; needs `nodeModulesDir: "auto"`, no `@deno/vite-plugin`). |
| @xterm/xterm                | 6.0.0                                  |                                                                                                                                               |
| vite / plugin-react         | 8.3.3 / 6.1.2                          | rolldown-based; `worker.format: "iife"` for the engine worker.                                                                                |
| react / react-dom           | 19.3.0                                 | `@types/react*` 19.3.0 via `jsxImportSourceTypes`.                                                                                            |
| @playwright/test            | 1.62.0                                 | Matches the cached `chromium-1234`; 1.63+ need a browser download. Runs directly under Deno.                                                  |
| fast-check                  | 4.10.2                                 | Property test with fixed seed 20261007, `verbose: 1`, replay via `PROTOTYPER_REPLAY_PATH`.                                                    |
| @std/assert, @std/http      | 1.0.19                                 | `@std/http` is in `imports` only so the file-server used by `serve:static`/`test:static` is locked.                                           |
| SQLite Fiddle (vendored)    | 3.54.0 trunk `4bfc6e53a9`, emsdk 5.0.1 | `public/vendor/fiddle/`, provenance and sha256s in `PROVENANCE.md` there. Not an npm package.                                                 |
| @duckdb/duckdb-wasm(+shell) | 1.32.0                                 | **Not installed by R0** (D2/DB1 add them). Pin stays as Q13 says: engine 1.4.3, never `latest`.                                               |
| @sqlite.org/sqlite-wasm     | 3.53.4-build2                          | **Not installed by R0** (D1 adds it for Deno-side conformance only).                                                                          |

### Lockfile and the minimum-dependency-age policy

`deno install` refused `effect@4.0.2` because it was younger than 24 hours. The
lock was written once with `deno install --minimum-dependency-age=0`; every
later command (`deno task check/test/build`, Playwright under Deno) resolved
from `deno.lock` without the flag (exit 0). Nothing in `deno.json` weakens the
policy. If the lock is ever deleted before 2026-10-08T18:21Z, regenerate it the
same way; after that date the plain `deno install` works.

## Static build contents (`deno task build`, 4.1 MB on disk)

| Asset                                       |        min |     gzip | What                                                             |
| ------------------------------------------- | ---------: | -------: | ---------------------------------------------------------------- |
| `assets/vendor-just-bash-*.js`              | 1,266.7 kB | 349.8 kB | just-bash browser bundle (shell, in-memory FS, jq, coreutils)    |
| `assets/vendor-xterm-*.js` + css            |   330.9 kB |  83.0 kB | xterm.js 6                                                       |
| `assets/vendor-react-dom-*.js`              |   210.5 kB |  65.7 kB |                                                                  |
| `assets/vendor-effect-*.js`                 |    80.8 kB |  26.9 kB | Effect 4 (Context/Layer/ManagedRuntime/Schema/Ref used)          |
| `assets/vendor-react-*.js`                  |     8.2 kB |   3.1 kB |                                                                  |
| `assets/index-*.js`                         |     7.0 kB |   3.4 kB | playground + terminal package + worker client                    |
| `assets/worker-*.js`                        |     2.1 kB |        – | engine worker, classic (iife) script                             |
| `vendor/fiddle/fiddle-module.js`            |   827.5 kB |        – | upstream sqlite3 JS bundle + Emscripten glue, copied as-is       |
| `vendor/fiddle/fiddle-module.wasm`          | 1,435.2 kB |        – | SQLite 3.54.0 + shell, `application/wasm` from the static server |
| `vendor/fiddle/sqlite3-opfs-async-proxy.js` |    41.7 kB |        – | only used by the `opfs` VFS under COOP/COEP (deferred, Q15)      |
| `vendor/fiddle/PROVENANCE.md`               |       4 kB |        – | copied because it sits in `public/`; harmless                    |

The build emits one warning: `node:zlib` is externalized for just-bash; only its
`gzip`/`gunzip`/`zcat` use it. No `define`, `optimizeDeps`, alias or polyfill is
configured.

## Header needs

- **None.** The static suite runs from `jsr:@std/http` file-server with default
  headers. `crossOriginIsolated` is `false` in the engine worker and everything
  in R0 works that way. The file-server sends `application/wasm` for `.wasm`
  (asserted by the smoke test), so streaming compilation is possible; Emscripten
  falls back to `ArrayBuffer` instantiation if a host ever serves the wrong
  type.
- COOP/COEP are needed only for shell cancellation (SharedArrayBuffer +
  `sqlite3_progress_handler`) and the multi-tab `opfs`/`opfs-wl` VFSes, both
  deferred by Q15. `deno task test:static:coi` does not exist yet.

## Engine worker (`packages/database/worker.ts`)

- One classic Web Worker per prototype instance. It is a classic worker because
  the Fiddle bundle is loaded with `importScripts()`; module workers cannot do
  that. Consequences, all verified: the file has **no `import`/`export`**
  (type-only aliases via `type X = import("...").X`), Vite serves it with an
  injected `importScripts("/@vite/env")` in dev and bundles it as an iife in
  build, and `new Worker(new URL("./worker.ts", import.meta.url))` must stay a
  literal expression for Vite to pick it up.
- Lifecycle: the host sends `{family:"lifecycle", op:"init", vendorDir, args?}`
  (R0 addition to the §9 protocol). The worker
  `importScripts(vendorDir +
  "fiddle-module.js")`, runs
  `sqlite3InitModule({print, printErr, locateFile})`, calls
  `capi.sqlite3_shutdown()` and `fiddle_main(argc, argv)` with argv
  `["sqlite3-fiddle.wasm", "/fiddle.sqlite3"]` (Q17: no `-safe`, no `-bail`),
  then posts `{op:"ready", info}`. Executed result from the static build:
  `libversion 3.54.0`, `sourceId 2026-10-05 14:22:13 4bfc6e53a9…`,
  `filename ""`, `vfs null`, `handle "0"`,
  `prompt "SQLite-3.54 fiddle.sqlite3-> "`. The shell opens its database lazily,
  so the handle is 0 until the first submission; D1 and DB0 must re-read
  `fiddle_db_handle()` per call (POC gotcha 8).
- `vendorDir` defaults to `${import.meta.env.BASE_URL}vendor/fiddle/` on the
  main thread (`/vendor/fiddle/` here). The worker URL does **not** carry
  `?sqlite3.dir=`; that query is only read by the OPFS async-proxy loader, which
  Q15 defers. Add it to the worker URL if `opfs` is ever enabled.
- Shell stdout/stderr from Emscripten arrive as `{family:"shell", op:"output"}`
  events (one line each). `fiddle_main` with these flags prints no banner.
- `exec` requests answer `{ok:false, error:{_tag:"DatabaseError", operation}}`
  with "not implemented in R0"; `shell` requests answer a stderr output event
  plus the live prompt. Both stubs are exercised by the smoke test so D1/DB0
  replace known-good plumbing.
- `packages/database/worker-client.ts` is a plain promise/listener client plus
  `engineWorkerScoped()` (Effect `acquireRelease`; the finalizer calls
  `worker.terminate()`). React StrictMode double-mounts the playground: the
  cleanup terminates the first worker and a second one is spawned.

## Terminal (`packages/terminal/`)

- xterm.js renders and collects lines; just-bash executes them; custom commands
  are `defineCommand` wrappers. Verified in the browser and natively under Deno:
  quoted arguments arrive as one argv entry (`tasks create "Build API"` →
  `created 1: Build API`), `tasks list --json | jq '.[].title'` renders the
  piped jq output, a typed failure (`TaskNotFound`) renders red stderr plus
  `[exit 1]`, `||` sees the exit status, Up-arrow history replays the command.
- Custom-command stdin is a just-bash `ByteString` (latin1, one char per byte).
  `decodeBytesToUtf8` exists only in the **Node** bundle; the browser bundle
  (`dist/bundle/browser.js`) does not export it (the dev server threw
  `does not provide an export named 'decodeBytesToUtf8'`). `effect-command.ts`
  decodes locally with `TextDecoder`.
- just-bash's bundled `sqlite3` prints "command not available in browser
  environments" and exits 127. It is not the database console and must not be
  used as one (plan.md §5).
- Under Deno, each `new Bash()` logs
  `[DefenseInDepthBox] Could not patch
  process.report / protect process.execPath`
  to stderr (20 lines in `deno task test`); harmless, tests pass.
- Effect 4.0.2 forms used: `Context.Service<Self, Shape>()("key")`, curried
  `Layer.succeed(Tag)(impl)` / `Layer.effect(Tag)(eff)`, `ManagedRuntime.make`,
  `Schema.TaggedError`, `Schema.decodeUnknownEffect`, `Effect.catch`,
  `Effect.acquireRelease(acquire, release)`, and `Effect.tryPromise(thunk)`
  which has a single form failing with `Cause.UnknownError` (map it with
  `Effect.mapError`).

## Unsupported assumptions (do not rely on these)

- No SQL executes through the worker yet; `exec` is a stub (D1). No shell input
  reaches `fiddle_exec` yet; `shell` is a stub (DB0).
- No persistence: the Fiddle database is `/fiddle.sqlite3` on Emscripten MEMFS;
  it is lost on reload. OPFS modes, COOP/COEP mode and cancellation are not
  built.
- No DuckDB assets are installed or vendored.
- The `prototype:new` task, demos, the `DatabaseEditor` host and the
  `DatabaseService` implementations do not exist; `packages/core/types.ts` only
  freezes their signatures.
- The Fiddle snapshot is unreleased trunk; a rebuild script is deferred (Q17).
- `npx playwright test` and Playwright versions other than 1.62.0 were not run
  on this machine.
