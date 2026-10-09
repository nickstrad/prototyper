# Bookmarks API demo

Run from the repository root:

```sh
/root/.deno/bin/deno run -A npm:vite@8.3.3 --config demos/api/vite.config.ts --host 127.0.0.1 --port 5300 --strictPort
```

Open <http://127.0.0.1:5300/demos/api/>. Only **API** and **Database** views are
wired. One D1 SQLite service and its engine worker back both views. The API
explorer constructs standard Requests and calls the shared router in-process;
there is no HTTP API server or network request. The R9 native adapter is a
reference for this handler shape, not a second database or required server.

SQLite uses memory for a repeatable demo: reloading restores the seed. Database
Reset also restores it; Export can save a SQLite image. No OPFS durability is
claimed.

## Walkthrough

1. In API, click **List bookmarks**, then **Send**. GET `/bookmarks` returns the
   two seeded bookmarks with status 200.
2. Choose **Create bookmark**, then **Send**. POST `/bookmarks` returns 201, the
   new row and a Location header. List again to see it persisted in SQLite.
3. Choose **Delete bookmark 1**, then **Send**. DELETE `/bookmarks/1` returns
   the deleted row with 200. A second deletion returns 404. Edit Path to delete
   another id returned by POST.
4. Choose **Invalid request**, then **Send**. An invalid URL returns 400 and an
   `InvalidInput` JSON explanation. No row is inserted. Malformed JSON also
   returns 400 (`InvalidJson`). Titles must be nonblank, at most 200 characters;
   URLs must use HTTP(S), at most 2048 characters. NUL characters are rejected.
5. Switch to Database and enter this in the real upstream SQLite console:

   ```sql
   INSERT INTO bookmarks(title, url) VALUES ('From shell', 'https://example.com/shell');
   ```

   The table preview updates and reports a shell write. Switch to API, choose
   **List bookmarks**, then **Send**: the new row appears. There is no snapshot
   copy or cache between the shell and API.

## Verification

Run all commands from the repository root. Browser tests use one worker and
start/stop their own server. Avoid sharing these ports with another run.

```sh
/root/.deno/bin/deno fmt --check demos/api
/root/.deno/bin/deno lint demos/api
/root/.deno/bin/deno check demos/api/main.tsx demos/api/api.ts demos/api/tests/api_test.ts demos/api/tests/demo.spec.ts demos/api/playwright.config.ts demos/api/vite.config.ts
/root/.deno/bin/deno test --allow-read demos/api/tests/api_test.ts
PW_OUT=test-results-r11-dev /root/.deno/bin/deno run -A npm:@playwright/test@1.62.0 test -c demos/api/playwright.config.ts
/root/.deno/bin/deno run -A npm:vite@8.3.3 build --config demos/api/vite.config.ts
PW_TARGET=static PW_DIST=dist-r11 PW_OUT=test-results-r11-static /root/.deno/bin/deno run -A npm:@playwright/test@1.62.0 test -c demos/api/playwright.config.ts
```

The static build's entry is `/demos/api/index.html`, served on port 4300 by the
static test command. Existing root build/test tasks do not discover this demo's
HTML entry or Playwright tests; no shared config edits are required.

The mutation pass temporarily changes only this demo and always restores its
source and production build. Run it with no other R11 server active:

```sh
python3 demos/api/tests/mutations.py /tmp/r11-mutations
```
