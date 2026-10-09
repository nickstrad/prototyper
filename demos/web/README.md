# Web notes demo

From the repository root:

```sh
/root/.deno/bin/deno run -A npm:vite@8.3.3 --host 127.0.0.1 --port 5301 --strictPort
```

Open http://127.0.0.1:5301/demos/web/. Create, edit, and delete notes in
Application. In Database, type into the real SQLite shell:

```sql
UPDATE notes SET body = 'Hello from SQL' WHERE id = 1;
```

Return to Application to see the change. Reset notes restores the two original
notes, removes additions, and clears the draft.

The page owns one scoped worker and D1 SQLite service. The upstream shell
binding uses that same worker. The Application subscribes before its initial
read and refreshes only after database change events, including while its view
is hidden. Neither actions nor tab switches reload its list. Unmount interrupts
the watcher and closes the scope. This demo deliberately uses **in-memory
SQLite**: reloading the page starts a new seeded session. Only Application and
Database are wired.

## Verification

```sh
/root/.deno/bin/deno test demos/web/application_test.ts
PW_OUT=/tmp/r12-playwright PW_DIST=dist-r12 /root/.deno/bin/deno run -A npm:@playwright/test@1.62.0 test --config demos/web/playwright.config.ts
/root/.deno/bin/deno fmt --check demos/web
/root/.deno/bin/deno lint demos/web
/root/.deno/bin/deno check demos/web/main.tsx demos/web/application_test.ts demos/web/notes.spec.ts demos/web/playwright.config.ts
```

The local Playwright configuration uses one worker and port 5301. It starts and
stops its own dev server. The browser suite covers CRUD, SQL shell coherence,
idle snapshot counts, exact reset, and desktop/narrow screenshots. The Deno test
independently reads SQL rows to verify storage and string quoting.

Run evidence and mutation results:
`agent-work/items/R12/attempts/run-20261008-12-01/`.
