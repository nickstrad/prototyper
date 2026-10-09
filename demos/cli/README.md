# CLI inventory demo

Start from the repository root:

```sh
/root/.deno/bin/deno run -A npm:vite@8.3.3 --config demos/cli/vite.config.ts --host 127.0.0.1 --port 5199 --strictPort
```

Open <http://127.0.0.1:5199/demos/cli/>. The only views are **Terminal**
(application commands interpreted by just-bash) and **Database** (the upstream
SQLite shell and shared DatabaseEditor). Both use one D1 SQLite service/worker.
The database is in memory; a reload or `db reset` restores the single seeded
bolt. No API or web application panel is registered.

## Walkthrough

In **Terminal**, run each line separately:

```sh
inventory list
inventory add washer "Wide washer" 4
inventory list | jq -r '.[].name'
echo '{"sku":"nut","name":"Brass nut","quantity":8}' | inventory add --json | jq -r '.sku'
inventory list --json | jq '.[] | select(.sku == "nut")'
inventory remove washer
```

Expected: the initial list has `bolt` / `Steel bolt` / `12`; the name pipeline
prints Steel bolt and Wide washer; JSON input adds `nut` and the output pipeline
prints `nut`; its list entry has quantity 8. Removing washer leaves bolt and
nut. Click **inventory** in the Database table list to inspect these same rows.

In the **Database** SQLite shell, enter this SQL and press Enter:

```sql
INSERT INTO inventory VALUES ('shell', 'Written in SQLite shell', 19);
```

Back in **Terminal**, verify that shell write through the CLI:

```sh
inventory list | jq '.[] | select(.sku == "shell")'
```

Expected:

```json
{ "sku": "shell", "name": "Written in SQLite shell", "quantity": 19 }
```

The application shell can also write SQL and read it through the inventory CLI:

```sh
db sql "UPDATE inventory SET quantity = 20 WHERE sku = 'shell'"
inventory list | jq '.[] | select(.sku == "shell") | .quantity'
inventory remove shell
db reset
```

Expected: `changes: 1`, then `20`, then `{"removed":"shell"}`. Reset restores
only the original bolt. This is a browser shell with a virtual filesystem, not
access to your operating system's shell or files.

## Command contract

- `inventory list [--json]`: sorted JSON array; JSON is always the output
  format.
- `inventory add SKU NAME QUANTITY`: insert a new SKU (duplicates fail).
- `inventory add --json`: read one `{sku,name,quantity}` object from stdin.
- `inventory remove SKU`: delete one item (a missing SKU fails).
- `db`: shared toolkit commands for SQL, schema, tables, info, and reset.

Names and SKUs accept Unicode and quotes, must be nonblank, at most 1000
characters, and cannot contain NUL or lone surrogates. Quantities must be
nonnegative safe integers. Expected failures go to stderr with nonzero status;
usage/JSON syntax errors return 2. Large truncated lists fail explicitly.

## Verification

```sh
/root/.deno/bin/deno fmt --check demos/cli
/root/.deno/bin/deno lint demos/cli
/root/.deno/bin/deno check demos/cli/*.ts demos/cli/*.tsx
/root/.deno/bin/deno test --allow-read demos/cli/inventory_test.ts
PW_PORT=5199 PW_OUT=/tmp/r10-browser PW_DIST=dist-r10 /root/.deno/bin/deno run -A npm:@playwright/test@1.62.0 test --config demos/cli/playwright.config.ts --workers 1
```

The native tests run the same commands on D1's native SQLite backend. The
browser test types into both terminals, proves actual SQLite shell sharing,
checks the two views, and captures desktop/mobile screenshots. The demo is
served as a Vite HTML entry; the root production build does not include it
automatically.

Build this demo alone and verify its static site with:

```sh
/root/.deno/bin/deno run -A npm:vite@8.3.3 build --config demos/cli/vite.config.ts
PW_TARGET=static PW_PORT=4199 PW_OUT=/tmp/r10-browser-static PW_DIST=dist-r10 /root/.deno/bin/deno run -A npm:@playwright/test@1.62.0 test --config demos/cli/playwright.config.ts --workers 1
```

`PW_PORT` selects the isolated dev port (default `5199`, or `4199` for
`PW_TARGET=static`). `PW_OUT` is the absolute directory for Playwright output,
terminal transcripts, and screenshots; every evidence file is written there.
