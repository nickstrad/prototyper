# Demo gallery

Run `deno task dev` and open <http://127.0.0.1:5173/demos/>. For asset-only
hosting, run `deno task build` then `deno task serve:static` and open
<http://127.0.0.1:4173/demos/>. All five HTML entry points are included in the
root build. Serve the complete output at the origin root.

| URL                 | Example         | Engine | Views                                | Walkthrough                      |
| ------------------- | --------------- | ------ | ------------------------------------ | -------------------------------- |
| `/demos/cli/`       | Inventory       | SQLite | Terminal, Database                   | [Inventory](cli/README.md)       |
| `/demos/api/`       | Bookmarks       | SQLite | API, Database                        | [Bookmarks](api/README.md)       |
| `/demos/web/`       | Notes           | SQLite | Application, Database                | [Notes](web/README.md)           |
| `/demos/combined/`  | Task manager    | SQLite | Application, Terminal, API, Database | [Tasks](combined/README.md)      |
| `/demos/analytics/` | Event analytics | DuckDB | Application, Database                | [Analytics](analytics/README.md) |

Each demo starts with deterministic data in a memory database. Reload discards
edits. The Database view embeds the actual upstream engine shell against the
same service used by the other views. SQLite supports its own dot commands;
DuckDB supports its upstream web shell commands and SQL such as `SHOW TABLES`
and `DESCRIBE events`.

`tests/static/gallery.spec.ts` checks the five entries independently of the
registry, blocks external network traffic, executes mutations through each
interface, and checks the live shells. The root browser suite includes these
checks in both dev and production modes. Run one Playwright worker:

```sh
deno task test:static --workers 1
```

Downloads occur during setup/build only. The API explorer uses an in-process
fetch router; bookmark URLs are stored data, not outgoing requests. SQLite,
DuckDB, workers, shell WASM, and DuckDB extensions are served locally. There is
no service-worker installation or cached-site guarantee after shutting down the
asset server.
