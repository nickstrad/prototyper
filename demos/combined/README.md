# Combined task manager

Four views of one SQLite database: Terminal, API, Application, and Database. The
task rules, deterministic three-task seed, CLI adapter and React UI come from
`prototypes/task-manager/`. The existing API explorer uses that same domain API.
This demo only owns composition, lifecycle, presentation and tests.

From the repository root:

```sh
/root/.deno/bin/deno run -A npm:vite@8.3.3 --config demos/combined/vite.config.ts --host 127.0.0.1 --port 5302 --strictPort
```

Open <http://127.0.0.1:5302/demos/combined/>. No backend server or external
account is needed. API requests are standard Request/Response objects handled in
the browser, not network endpoints. The SQLite database uses memory persistence:
reload starts fresh; the Application's Reset restores the seed within the same
live database. Each tab has its own database.

## Walkthrough

1. In **Terminal**, enter `tasks create "Ship combined demo"`. On a fresh page
   the response is `created 4: Ship combined demo`. Use the actual returned ID
   if you have already created tasks.
2. In **API**, select `POST`, enter `/tasks/4/complete`, leave the body empty,
   and click **Send**. Expect status 200 and `"completed": true`.
3. In **Application**, inspect “Ship combined demo”: its checkbox is checked.
4. In **Database**, enter `.mode table`, then
   `SELECT id, title, completed FROM tasks WHERE id = 4;`. The upstream SQLite
   shell shows the same title and `completed` equal to `1`.
5. In the shell, run `UPDATE tasks SET title = 'Edited in SQL' WHERE id = 4;`.
   The Application updates automatically. Inspect it with `tasks get 4 --json`
   in Terminal and `GET /tasks/4` in API.
6. Create a task in Application and inspect it from the other views. Click Reset
   in Application to restore the three seed tasks everywhere.

The Terminal runs just-bash with R1's `tasks` and the shared `db` commands (try
`tasks list --json | jq '.[].title'`). Database is the reusable `DatabaseEditor`
with the actual upstream Fiddle shell, including `.schema`, `.mode`, table
preview, and reset. SQL can intentionally create data the domain rejects; the
Application reports that error and recovers after SQL repair or Reset.

`session.ts` owns one worker and one D1 service seeded by R1. The UI, API, and
Terminal borrow layers over that service; the Database binding borrows the same
worker and service. Unmount retires adapters and releases the owner. Terminal
surfaces scroll horizontally on narrow screens so SQL output stays intact.

## Verification and static build

Tests stay inside this directory; use its Playwright config (one worker).

```sh
/root/.deno/bin/deno fmt --check demos/combined
/root/.deno/bin/deno lint demos/combined
/root/.deno/bin/deno check demos/combined/*.ts demos/combined/*.tsx
/root/.deno/bin/deno test --allow-read demos/combined/wiring_test.ts
PW_OUT=test-results-r13-dev /root/.deno/bin/deno run -A npm:@playwright/test@1.62.0 test --config demos/combined/playwright.config.ts --workers 1
/root/.deno/bin/deno run -A npm:vite@8.3.3 build --config demos/combined/vite.config.ts
PW_TARGET=static PW_DIST=dist-r13 PW_OUT=test-results-r13-static /root/.deno/bin/deno run -A npm:@playwright/test@1.62.0 test --config demos/combined/playwright.config.ts --workers 1
```

The standalone build writes only `dist-r13/`, includes vendored assets from
`public/`, and serves `/demos/combined/` on port 4302 in static tests without
COOP/COEP headers. Playwright starts/stops its own server. No root tasks or
configuration changes are needed. The browser tests use visible controls,
including keyboard input to both terminals, and prove the walkthrough, SQL and
UI writes observed across views, reset, and inherited validation.
