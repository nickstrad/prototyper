# R0 stack proof of concept

Deno-first Vite + React + xterm.js + just-bash + Effect 4 + fast-check +
Playwright. Executed on 2026-10-07 with Deno 2.7.14, Node v22.x, macOS,
uncommitted tree. Every verdict below links to captured output in `evidence/`.
Items marked **not executed** were not run.

## Verdicts

| # | Item                                                                                  | Verdict                                                                                                                                                                                                                                                                                       | Evidence                                                                                    |
| - | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 1 | Deno + Vite 8 + React 19, `dev`/`build`/`check`/`test`/`test:browser` tasks           | **Works.** Needs `nodeModulesDir: "auto"`. Do not use `@deno/vite-plugin` (see gotcha 1).                                                                                                                                                                                                     | `evidence/task-*.txt`, `evidence/nodemodules-none-experiment.txt`                           |
| 2 | xterm.js 6 + just-bash 3.6 in browser, custom commands                                | **Works.** Quoted args, `\| jq`, `tr`, stderr and nonzero exit, history recall. No Node polyfills, no `define`/`optimizeDeps`/alias. In-browser `jq` works. Bundled `sqlite3` does not break the bundle; at run time it prints "command not available in browser environments" and exits 127. | `evidence/task-test-browser.txt`, `evidence/terminal-*.png`                                 |
| 3 | Effect 4.0.2 `ManagedRuntime` + injected clock + `Schema.TaggedError` → stderr/exit 1 | **Works** in `deno test` and in the Vite bundle. fast-check `asyncProperty` with fixed seed prints seed and path. Replaying that path reproduces the shrunk counterexample.                                                                                                                   | `evidence/task-test.txt`, `evidence/property-fail-demo.txt`, `evidence/property-replay.txt` |
| 4 | Playwright runner                                                                     | **Both work.** `deno run -A npm:@playwright/test@1.62.0 test` (recommended) and `npx playwright test` both pass. Exit codes propagate (pass = 0, no tests matched = 1).                                                                                                                       | `evidence/task-test-browser.txt`, `evidence/playwright-npx-dev.txt`                         |
| 5 | Static build served without backend                                                   | **Works.** `jsr:@std/http@1/file-server dist` + same spec.                                                                                                                                                                                                                                    | `evidence/task-test-static.txt`, `evidence/terminal-static.png`                             |
| 6 | `deno fmt`/`lint`/`check` over tsx, tests, configs                                    | **Works** with the compilerOptions below. Fixes were needed for two lint rules.                                                                                                                                                                                                               | `evidence/task-check.txt`                                                                   |

## Versions (pinned, all in `deno.lock`)

effect 4.0.2 · just-bash 3.6.0 · @xterm/xterm 6.0.0 · vite 8.3.3 (rolldown) ·
@vitejs/plugin-react 6.1.2 · react/react-dom/@types 19.3.0 · fast-check 4.10.2 ·
@playwright/test **1.62.0** · @std/assert 1 (1.0.19).

Playwright 1.62.0 is pinned on purpose. It is the release that uses the cached
`chromium-1234`. 1.63 wants 1243 and 1.64 wants 1248, so those versions need
`playwright install chromium` or `channel: "chrome"`. Neither was executed.

## Final `deno.json`

```jsonc
{
  "nodeModulesDir": "auto",
  "tasks": {
    "dev": "deno run -A npm:vite@8.3.3",
    "build": "deno run -A npm:vite@8.3.3 build",
    "serve:static": "deno run -A jsr:@std/http@1/file-server dist --host 127.0.0.1 --port 4173",
    "check": "deno fmt --check && deno lint && deno check",
    "test": "deno test --allow-env=POC_FAIL_DEMO,POC_REPLAY_PATH tests/",
    "test:browser": "deno run -A npm:@playwright/test@1.62.0 test",
    "test:browser:npx": "npx playwright test",
    "test:static": "deno task build && PW_TARGET=static deno run -A npm:@playwright/test@1.62.0 test"
  },
  "imports": {
    "effect": "npm:effect@4.0.2",
    "just-bash": "npm:just-bash@3.6.0",
    "...": "see file"
  },
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "react",
    "jsxImportSourceTypes": "@types/react",
    "lib": ["dom", "dom.iterable", "esnext", "deno.ns"]
  },
  "exclude": ["dist", "node_modules", "test-results", "playwright-report"]
}
```

`vite.config.ts` contains only `@vitejs/plugin-react` and a `manualChunks`
function. The function splits vendor chunks so the build output shows the size
of each package. No `define`, `optimizeDeps`, alias or polyfill is needed.
`deno test` needs no permissions except the two opt-in env vars for the demo and
replay. just-bash under Deno needed none.

## Effect 4.0.2 import paths and API forms actually used

All imports come from the root:
`import { Context, Effect, Exit, Layer, ManagedRuntime, Ref, Schema } from "effect"`.

- **Service tags are in `Context`, not `ServiceMap`.** `effect@4.0.2/dist` has
  no `ServiceMap` module. The form is
  `class AppClock extends Context.Service<AppClock, Shape>()("AppClock") {}`.
- Layers are curried: `Layer.succeed(Tag)(impl)` and
  `Layer.effect(Tag)(effect)`. `Layer.mergeAll(...)` composes them.
- Runtime: `ManagedRuntime.make(layer)`, then `runtime.runPromise(eff)`, then
  `runtime.dispose()`. The type is `ManagedRuntime.ManagedRuntime<R, E>`. Not
  `Layer.toRuntime`.
- Errors:
  `class TaskNotFound extends Schema.TaggedError<TaskNotFound>()("TaskNotFound", { id: Schema.Number }) {}`.
  These are yieldable: `return yield* new TaskNotFound({ id })`.
- Recovery: use `Effect.catch` (exported as `catch_ as catch`). There is no
  `Effect.catchAll`. Also used: `Effect.flip`, `Effect.runPromiseExit`,
  `Exit.isSuccess`.
- Validation: `Schema.String.check(Schema.isNonEmpty())` and
  `Schema.decodeUnknownEffect(schema)(input)`. The decode fails with
  `SchemaError`, which we map to the domain `InvalidInput`.
- Effect is about 81 kB minified (27 kB gzip) in the browser bundle for this
  usage.

## Bundle sizes (`deno task build`, `evidence/build-output.txt`)

| asset             |        min |     gzip |
| ----------------- | ---------: | -------: |
| vendor-just-bash  | 1,266.7 kB | 349.8 kB |
| vendor-xterm (js) |   330.9 kB |  83.0 kB |
| vendor-react-dom  |   210.5 kB |  65.7 kB |
| vendor-effect     |    80.8 kB |  26.9 kB |
| vendor-react      |     8.2 kB |   3.1 kB |
| app (index)       |     4.2 kB |   2.1 kB |
| xterm css         |     3.9 kB |   1.0 kB |

Total `dist/` is 1.8 MB. just-bash is about 70% of the JS. The build emits one
harmless warning: `node:zlib` is externalized, and only `gzip`/`gunzip`/`zcat`
use it.

## Gotchas

1. **`@deno/vite-plugin` breaks just-bash.** We tested `nodeModulesDir: "none"`
   with the Deno plugin. Deno's resolver ignored the package's `"browser"`
   export. It picked the Node bundle and externalized 28 `node:*` builtins.
   Without the plugin and with `"none"`, Vite cannot load `vite.config.ts` at
   all. Use `"auto"` with plain Vite, which honours the `browser` condition.
2. Under Deno, just-bash prints
   `[DefenseInDepthBox] Could not patch process.report / protect process.execPath`
   for each `Bash` construction. This is 16 lines in `deno task test`, and the
   tests still pass. `defenseInDepth: false` silences it. We kept the default
   (`probes/defense_in_depth.ts`). The browser console showed no warnings.
3. `deno install` reports ignored build scripts for the optional just-bash deps
   `@mongodb-js/zstd` and `node-liblzma`. We did not run `approve-scripts`, and
   nothing needed them. It also shows deprecation notices for `re2js@1.4.0` and
   `prebuild-install`.
4. Deno lint rules: `no-process-global` fires in Playwright files, so use
   `import process from "node:process"`. That form also type-checks under
   `deno check` and runs under Node. `no-control-regex` fires on terminal input
   filtering.
5. just-bash `exec()` resets env/cwd for each call, but the FS is shared. Our
   adapter runs one `exec` per line. Custom command stdin is a `ByteString`, so
   decode it with `decodeBytesToUtf8`.
6. React StrictMode mounts the effect twice. The cleanup must dispose the
   terminal, the session and the `ManagedRuntime`.
7. `jsr:@std/http@1/file-server` run as a task specifier is not written into
   `deno.lock`. For locking, add `@std/http` to `imports`. Not done here.
8. Vite 8 hints `build.rolldownOptions.output.codeSplitting`. The
   `rollupOptions.output.manualChunks` form we used still works.

## Layout

```
src/core/tasks.ts        portable core: AppClock, TaskStore, TaggedErrors, ops
src/core/runtime.ts      ManagedRuntime.make(AppLayer(clock))
src/terminal/commands.ts defineCommand("hello"|"tasks") -> runtime.runPromise, errors -> stderr/exit 1
src/terminal/shell.ts    new Bash({ customCommands })
src/terminal/xterm-adapter.ts line editor: history (Up/Down), backspace, stderr in red, "[exit N]"
src/App.tsx              mounts xterm, exposes window.__term for Playwright buffer reads
tests/                   deno test: core (fixed clock), shell (same path as browser), property
e2e/terminal.spec.ts     one spec reused for dev (5173) and static (PW_TARGET=static, 4173)
```

## Recommended R0 task surface

- `nodeModulesDir: "auto"`, commit `deno.lock`, and pin exact versions in
  `imports`.
- `dev`: `deno run -A npm:vite@<v>` · `build`: `... vite build`.
- `check`: `deno fmt --check && deno lint && deno check`, with `exclude` for
  `dist`, `node_modules`, `test-results` and `playwright-report`.
- `test`: `deno test` with explicit, minimal `--allow-env=` names. No other
  permissions were needed.
- `test:browser`: `deno run -A npm:@playwright/test@<v> test`. This is
  Deno-first and verified. Keep `npx playwright test` only as a fallback.
- `test:static`: `deno task build && PW_TARGET=static <playwright>`. `webServer`
  runs `jsr:@std/http@1/file-server dist`.
- Pin Playwright to match the installed browser revision, or add an explicit
  `npx playwright install chromium` step.
- Property tests should use a fixed `seed`, `verbose: 1`, an env-driven `path`
  replay, and a fresh `ManagedRuntime` per case disposed in `finally`.
