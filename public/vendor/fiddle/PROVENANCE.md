# Provenance of public/vendor/fiddle/

These three files are the unmodified upstream SQLite Fiddle build, copied from
`pocs/sqlite-shell/vendor/fiddle/` (downloaded there on 2026-10-07 with
`curl -sSfL` from the live sqlite.org Fiddle deployment). Nothing was rebuilt
locally. The POC directory keeps the other upstream files (`index.html`,
`fiddle.js`, `fiddle-worker.js`, `jqterm/*`) as reference only; the toolkit
does not ship them.

- SQLite version: **3.54.0**, `SQLITE_VERSION_NUMBER 3054000`
- Source id:
  `2026-10-05 14:22:13 4bfc6e53a95d710b7f40fa9c80d8cdd1df50d69ed8614e9800f7e6a1ca5a3c29`
  (check-in https://sqlite.org/src/info/4bfc6e53a95d710b). This is a **trunk
  snapshot**, not a tagged release; the latest release on that date was 3.53.4.
  Q17 (plan.md §2): vendor the snapshot now, re-pin when 3.54.0 releases.
- Emscripten SDK used upstream: **5.0.1** (from the `@preserve` header of
  `fiddle-module.js`); 32-bit WASM built with `-sWASM_BIGINT`.
- Verified at runtime by `tests/browser/smoke.spec.ts`: `sqlite3_libversion()`
  returns `3.54.0` and `sqlite3_sourceid()` contains `4bfc6e53a9` when the
  engine worker loads these files from the static build.

| File                          | Upstream URL                                           |   Bytes | sha256                                                             |
| ----------------------------- | ------------------------------------------------------ | ------: | ------------------------------------------------------------------ |
| `fiddle-module.js`            | https://sqlite.org/fiddle/fiddle-module.js             |  827513 | `f6a2b7f3c0c1bd03405e3575dcc9b57b3fd5d66760bb3b630aa775ee2ecb9b90` |
| `fiddle-module.wasm`          | https://sqlite.org/fiddle/fiddle-module.wasm           | 1435205 | `533903e612168bf1b36e5d561fca27cd54f2771e0552f3bd8ea29d1ecfea86bd` |
| `sqlite3-opfs-async-proxy.js` | https://sqlite.org/fiddle/sqlite3-opfs-async-proxy.js  |   41745 | `d068ff39746de03642d60a1479b4c284e11bf69ef8d097c4da1b75983c9b0ca9` |

`fiddle-module.js` is the full sqlite3 JS bundle (`sqlite3.capi`, `sqlite3.oo1`,
`sqlite3.wasm.exports`) plus the Emscripten glue; it defines the global
`sqlite3InitModule` when loaded with `importScripts()` in a classic worker. It
loads `fiddle-module.wasm` through `Module.locateFile` and, only under
cross-origin isolation with the `opfs` VFS, starts
`sqlite3-opfs-async-proxy.js` (deferred by Q15; kept so the directory matches
upstream).

## Licence / terms

- SQLite C and JS code: public domain blessing, stated in the header of
  `fiddle-module.js` and the proxy.
- Emscripten glue in `fiddle-module.js`: MIT / University of Illinois NCSA.
- The Fiddle "About" page says it "is not an officially-supported deliverable of
  the SQLite project. It is subject to any number of changes or outright removal
  at any time." Never load it from sqlite.org at runtime; serve these copies.

## Re-verify or re-download

```sh
sha256sum public/vendor/fiddle/fiddle-module.js public/vendor/fiddle/fiddle-module.wasm \
  public/vendor/fiddle/sqlite3-opfs-async-proxy.js     # compare with the table above
# fresh copy (the live files change without notice; update the table if you do this):
for f in fiddle-module.js fiddle-module.wasm sqlite3-opfs-async-proxy.js; do
  curl -sSfL -o "public/vendor/fiddle/$f" "https://sqlite.org/fiddle/$f"; done
```
