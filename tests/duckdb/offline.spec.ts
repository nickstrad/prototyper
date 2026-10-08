// R6 offline: with every request outside this origin aborted, the analytics,
// its Database view (engine, worker, shell wasm) and DuckDB's json/parquet
// extensions all load from the page's own origin. Run against the static
// build (`vite build --outDir dist-r6`, plain file server) this is the
// "works offline from the static build" check.
import { expect, test } from "@playwright/test";
import { SEED_EVENT_COUNT } from "../../prototypes/event-analytics/seed.ts";
import { AGGREGATE_SQL } from "../../prototypes/event-analytics/queries.ts";
import {
  collectProblems,
  DUCKDB_ASSET,
  inst,
  loadPlayground,
  openAnalytics,
  openDatabaseView,
  saveEvidence,
  screenshot,
  shellQuery,
  target,
} from "./helpers.ts";

test.describe.configure({ timeout: 240_000 });

test("the analytics and its shell work offline: no request leaves the origin", async ({ page }) => {
  // duckdb-wasm warns once per file a statement writes that was not
  // registered first (COPY ... TO below).
  const problems = collectProblems(page);
  const requests: string[] = [];
  const blocked: string[] = [];
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== "127.0.0.1") {
      blocked.push(url.href);
      return route.abort();
    }
    requests.push(url.pathname);
    return route.continue();
  });
  await loadPlayground(page);
  await openAnalytics(page);
  await openDatabaseView(page);
  const totals = await shellQuery(page, AGGREGATE_SQL.totals);
  expect(totals.rows[0]?.[0]).toBe(String(SEED_EVENT_COUNT));
  // json and parquet autoload from the self-hosted extension repository.
  const out = await inst(page, async (h) => ({
    json: await h.execute("SELECT to_json({'n': count(*)}) AS j FROM events"),
    copy: await h.execute(
      "COPY (SELECT * FROM events) TO 'events.parquet' (FORMAT parquet)",
    ),
    read: await h.execute(
      "SELECT count(*) AS n FROM read_parquet('events.parquet')",
    ),
  }), null);
  expect(out.json.rows).toEqual([[`{"n":${SEED_EVENT_COUNT}}`]]);
  expect(out.read.rows).toEqual([[SEED_EVENT_COUNT]]);
  const parquet = await shellQuery(
    page,
    "SELECT count(*) AS n FROM read_parquet('events.parquet')",
  );
  expect(parquet.rows).toEqual([[String(SEED_EVENT_COUNT)]]);

  expect(blocked).toEqual([]);
  expect(requests).toContain("/vendor/duckdb/duckdb-eh.wasm");
  expect(requests).toContain(
    "/vendor/duckdb/extensions/v1.4.3/wasm_eh/json.duckdb_extension.wasm",
  );
  expect(requests).toContain(
    "/vendor/duckdb/extensions/v1.4.3/wasm_eh/parquet.duckdb_extension.wasm",
  );
  const shellWasm = requests.filter((p) =>
    p.includes("shell_bg") && p.endsWith(".wasm")
  );
  expect(shellWasm.length).toBeGreaterThan(0);
  if (target === "static") {
    expect(shellWasm[0]).toMatch(/^\/assets\/shell_bg-[\w-]+\.wasm$/);
  }
  expect(requests.filter((p) => p.includes("mvp"))).toEqual([]);
  saveEvidence(
    `06-offline-${target}.txt`,
    `blocked (outside the origin): ${
      JSON.stringify(blocked)
    }\nDuckDB requests:\n${
      requests.filter((p) => DUCKDB_ASSET.test(p) || p.includes("extensions"))
        .join("\n")
    }\n`,
  );
  await screenshot(page, "06-offline");
  expect(problems.filter((p) => !p.includes("Buffering missing file: ")))
    .toEqual([]);
});
