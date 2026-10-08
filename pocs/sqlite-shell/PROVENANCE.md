# Provenance of vendor/fiddle/

Downloaded 2026-10-07 with `curl -sSfL` from the live SQLite Fiddle deployment.
The files are unmodified. Nothing here was rebuilt locally (`emcc` is not installed).

- SQLite version: **3.54.0**, `SQLITE_VERSION_NUMBER 3054000`
- Source id: `2026-10-05 14:22:13 4bfc6e53a95d710b7f40fa9c80d8cdd1df50d69ed8614e9800f7e6a1ca5a3c29`
  (check-in https://sqlite.org/src/info/4bfc6e53a95d710b). This is a **trunk snapshot**,
  not a tagged release. The latest release on sqlite.org/download.html on this date is
  3.53.4 (`2026/sqlite-src-3530400.zip`).
- Emscripten SDK used upstream: **5.0.1** (from the `@preserve` header of `fiddle-module.js`)
- `fiddle-module.wasm` server Last-Modified: Mon, 05 Oct 2026 14:30:56 GMT
- 32-bit WASM (`wasm.ptr.size === 4`), built with `-sWASM_BIGINT` (int64 is a JS BigInt)

| File | URL | Bytes | sha256 |
| --- | --- | ---: | --- |
| `index.html` | https://sqlite.org/fiddle/index.html | 13938 | `8494e4352ce69b2efc333cfe1a33d8ebcbc781e8e7a92e9286f1e045f5da5927` |
| `fiddle.js` | https://sqlite.org/fiddle/fiddle.js | 34617 | `44029a853139d1daf25dc8e4b34075eb6efc237b6fc3f44e5a79abf32a1b12c4` |
| `fiddle-worker.js` | https://sqlite.org/fiddle/fiddle-worker.js | 14047 | `fcaefc6e88fcc1a495492d88eb4adf1a97590a5e08ee99f47a2f24630df788bf` |
| `fiddle-module.js` | https://sqlite.org/fiddle/fiddle-module.js | 827513 | `f6a2b7f3c0c1bd03405e3575dcc9b57b3fd5d66760bb3b630aa775ee2ecb9b90` |
| `fiddle-module.wasm` | https://sqlite.org/fiddle/fiddle-module.wasm | 1435205 | `533903e612168bf1b36e5d561fca27cd54f2771e0552f3bd8ea29d1ecfea86bd` |
| `sqlite3-opfs-async-proxy.js` | https://sqlite.org/fiddle/sqlite3-opfs-async-proxy.js | 41745 | `d068ff39746de03642d60a1479b4c284e11bf69ef8d097c4da1b75983c9b0ca9` |
| `jqterm/jquery.terminal.bundle.min.js` | https://sqlite.org/fiddle/jqterm/jquery.terminal.bundle.min.js | 272109 | `23c35a3cc3edbd7fe84f887387360895318678eab8e691ccb0c2d5990b6d5c3b` |
| `jqterm/jquery.terminal.min.css` | https://sqlite.org/fiddle/jqterm/jquery.terminal.min.css | 27192 | `cf552c44284f24639f4d5de8b7f7299b0ac888f68e78177a6cca2b4259d2a559` |

`index.html` loads `jqterm/*` and `fiddle.js`; `fiddle.js` starts `fiddle-worker.js`; the worker
`importScripts('fiddle-module.js')`, which loads `fiddle-module.wasm` and, under cross-origin
isolation, starts `sqlite3-opfs-async-proxy.js`. `https://sqlite.org/fiddle/emscripten.css` and
`sqlite3-fiddle.wasm` (the argv[0] string) return 404; they are not real assets.
The POC uses only `fiddle-module.js`, `fiddle-module.wasm` and `sqlite3-opfs-async-proxy.js`.
The others are kept as reference for the upstream message protocol.

## Licence / terms

- SQLite C and JS code: public domain blessing ("The author disclaims copyright to this source
  code"), stated in the header of `fiddle-module.js`, `fiddle-worker.js`, and the proxy.
- Emscripten glue in `fiddle-module.js`: MIT / University of Illinois NCSA (stated in the same header).
- `jqterm/jquery.terminal.bundle.min.js`: jQuery 1.7.1 (MIT) + jquery.terminal (MIT). Not used by the POC.
- The Fiddle "About" page says: *"it is not an officially-supported deliverable of the SQLite
  project. It is subject to any number of changes or outright removal at any time."* Treat the
  live URL as unpinned. Vendor the files (as done here) or rebuild from a tagged source tree.

## Re-download

```sh
cd vendor/fiddle
for f in index.html fiddle.js fiddle-worker.js fiddle-module.js fiddle-module.wasm \
         sqlite3-opfs-async-proxy.js jqterm/jquery.terminal.bundle.min.js jqterm/jquery.terminal.min.css; do
  mkdir -p "$(dirname "$f")"; curl -sSfL -o "$f" "https://sqlite.org/fiddle/$f"; done
shasum -a 256 */* *.*    # compare with the table above; the live files change without notice
```
