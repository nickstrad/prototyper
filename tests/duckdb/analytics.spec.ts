// R6 acceptance: the event analytics prototype on D2's DuckDB service with
// DB1's upstream shell in DB0's DatabaseEditor (plan.md §10b R6).
// - the aggregates render in the panel and the same SQL typed into the real
//   DuckDB shell prints the same numbers (both checked against an
//   independent oracle computed from the seed rows);
// - a shell INSERT changes the panel through the change stream, with exactly
//   one notification per submission (none for reads and failures);
// - reset restores the exact seed: panel, shell and R4's snapshot agree;
// - DuckDB assets load only when the analytics (engine) or its Database view
//   (shell) opens;
// - Q18: while another DuckDB shell owns the page the Database view says so,
//   and opens once that shell is disposed.
import { expect, type Page, test } from "@playwright/test";
import { SEED_EVENTS } from "../../prototypes/event-analytics/seed.ts";
import { AGGREGATE_SQL } from "../../prototypes/event-analytics/queries.ts";
import { type ExpectedOverview, expectedOverview } from "./oracle.ts";
import {
  collectProblems,
  DUCKDB_ASSET,
  inst,
  loadPlayground,
  openAnalytics,
  openDatabaseView,
  panelNotifications,
  readPanel,
  saveEvidence,
  screen,
  screenshot,
  section,
  shellQuery,
  target,
  typeLine,
} from "./helpers.ts";

test.describe.configure({ timeout: 240_000 });

const seedOverview = expectedOverview(SEED_EVENTS);
type Row = Parameters<typeof expectedOverview>[0][number];

/** What the shell's box tables print for the four aggregates. */
async function shellOverview(page: Page): Promise<ExpectedOverview> {
  const totals = await shellQuery(page, AGGREGATE_SQL.totals);
  expect(totals.header).toEqual(["events", "views", "signups", "revenue"]);
  const days = await shellQuery(page, AGGREGATE_SQL.eventsPerDay);
  expect(days.header).toEqual(["day", "views", "signups"]);
  const sources = await shellQuery(page, AGGREGATE_SQL.topSources);
  expect(sources.header).toEqual(["source", "events", "signups", "revenue"]);
  const countries = await shellQuery(page, AGGREGATE_SQL.conversionByCountry);
  expect(countries.header).toEqual([
    "country",
    "views",
    "signups",
    "conversion_pct",
  ]);
  const [events, views, signups, revenue] = totals.rows[0] ?? [];
  return {
    totals: {
      events: Number(events),
      views: Number(views),
      signups: Number(signups),
      revenue,
    },
    perDay: days.rows.map(([day, v, s]) => ({
      day,
      views: Number(v),
      signups: Number(s),
    })),
    sources: sources.rows.slice(0, 5).map(([source, e, s, r]) => ({
      source,
      events: Number(e),
      signups: Number(s),
      revenue: r,
    })),
    countries: countries.rows.map(([country, v, s, pct]) => ({
      country,
      views: Number(v),
      signups: Number(s),
      conversionPct: pct === "NULL" ? null : pct,
    })),
  };
}

/** The panel once it shows `expected` (it reloads from the change stream). */
async function panelShows(page: Page, expected: ExpectedOverview) {
  await expect.poll(() => readPanel(page), { timeout: 30_000 }).toEqual(
    expected,
  );
}

test("DuckDB loads only when the analytics opens; the shell only with its Database view", async ({ page }) => {
  const problems = collectProblems(page);
  const requests: string[] = [];
  page.on("request", (r) => requests.push(r.url()));
  await loadPlayground(page);
  await page.waitForLoadState("load");
  await page.waitForTimeout(3000);
  expect(requests.filter((u) => DUCKDB_ASSET.test(u))).toEqual([]);
  await expect(section(page).getByTestId("r6-closed")).toHaveText(
    "DuckDB not loaded",
  );

  await openAnalytics(page);
  const afterOpen = requests.filter((u) => DUCKDB_ASSET.test(u));
  expect(afterOpen.some((u) => u.includes("duckdb-eh.wasm"))).toBe(true);
  expect(afterOpen.filter((u) => u.includes("shell_bg"))).toEqual([]);

  await openDatabaseView(page);
  const all = requests.filter((u) => DUCKDB_ASSET.test(u));
  expect(all.some((u) => u.includes("shell_bg"))).toBe(true);
  const origin = new URL(page.url()).origin;
  expect(all.filter((u) => new URL(u).origin !== origin)).toEqual([]);
  saveEvidence(
    `00-assets-${target}.txt`,
    `before open: none\nafter "Open event analytics":\n${
      afterOpen.join("\n")
    }\nafter "Open database view":\n${all.join("\n")}\n`,
  );
  expect(problems).toEqual([]);
});

test("aggregates render in the panel and the real DuckDB shell prints the same numbers", async ({ page }) => {
  const problems = collectProblems(page);
  await loadPlayground(page);
  await openAnalytics(page);
  const panel = await readPanel(page);
  expect(panel).toEqual(seedOverview);
  // The hooks' encoded view (encodeCell) agrees with the DOM.
  const rendered = await inst(page, (h) => h.rendered(), null);
  expect(rendered?.totals).toEqual(seedOverview.totals);
  await expect(section(page).getByTestId("r6-status")).toContainText(
    "persistence memory",
  );
  await screenshot(page, "01-panel");

  await openDatabaseView(page);
  const shell = await shellOverview(page);
  expect(shell).toEqual(panel);
  saveEvidence(
    `01-shell-aggregates-${target}.txt`,
    (await screen(page)) + "\n",
  );
  await screenshot(page, "01-panel-and-shell");
  expect(problems).toEqual([]);
});

test("a shell INSERT changes the panel with exactly one notification per submission", async ({ page }) => {
  const problems = collectProblems(page);
  await loadPlayground(page);
  await openAnalytics(page);
  await openDatabaseView(page);
  const log: string[] = [];
  const changes = () => inst(page, (h) => h.changes(), null);
  const settleQuietly = async () => {
    // Long enough for a stray second event to arrive.
    await page.waitForTimeout(750);
    await inst(page, (h) => h.idle(), null);
  };
  /**
   * Panel reloads and the application's aggregate reads (4 per reload),
   * read after a quiet period: no polling, and exactly one reload per
   * change batch (here, one per submission).
   */
  const quietCounts = async () => {
    await page.waitForTimeout(2000);
    return await inst(
      page,
      (h) => ({ loads: h.loads(), reads: h.reads() }),
      null,
    );
  };
  expect(await changes()).toEqual([]);
  expect(await quietCounts()).toEqual({ loads: 1, reads: 4 });

  // A read: no notification, no reload.
  await typeLine(page, `${AGGREGATE_SQL.totals};`);
  await settleQuietly();
  expect(await changes()).toEqual([]);
  expect(await quietCounts()).toEqual({ loads: 1, reads: 4 });

  // One INSERT (id from the sequence): one write event, panel updated.
  const insert =
    "INSERT INTO events (occurred_on, kind, country, source, user_id, revenue) VALUES (DATE '2026-09-14', 'signup', 'JP', 'referral', 4242, 29.00);";
  await typeLine(page, insert);
  await settleQuietly();
  expect(await changes()).toEqual([
    { kind: "write", source: "shell", changes: 1, schemaChanged: false },
  ]);
  let rows: Row[] = [
    ...SEED_EVENTS,
    {
      day: "2026-09-14",
      kind: "signup",
      country: "JP",
      source: "referral",
      revenue: "29.00",
    } as const,
  ];
  await panelShows(page, expectedOverview(rows));
  await expect.poll(() => panelNotifications(page)).toBe(1);
  expect(await quietCounts()).toEqual({ loads: 2, reads: 8 });
  log.push(`after INSERT: ${JSON.stringify(await changes())}`);

  // A three-row INSERT in one submission: one more event.
  const multi =
    "INSERT INTO events (occurred_on, kind, country, source, user_id, revenue) VALUES (DATE '2026-09-15', 'page_view', 'US', 'email', 1, NULL), (DATE '2026-09-15', 'page_view', 'US', 'email', 2, NULL), (DATE '2026-09-15', 'signup', 'US', 'email', 2, 9.99);";
  await typeLine(page, multi);
  await settleQuietly();
  expect((await changes()).slice(1)).toEqual([
    { kind: "write", source: "shell", changes: 3, schemaChanged: false },
  ]);
  rows = [
    ...rows,
    ...[null, null, "9.99"].map((revenue) => ({
      day: "2026-09-15",
      kind: revenue ? "signup" : "page_view",
      country: "US",
      source: "email",
      revenue,
    } as const)),
  ];
  await panelShows(page, expectedOverview(rows));
  expect(await quietCounts()).toEqual({ loads: 3, reads: 12 });

  // A failing INSERT (duplicate key) and a no-op UPDATE: no notification.
  await typeLine(
    page,
    "INSERT INTO events VALUES (1, DATE '2026-09-01', 'signup', 'US', 'search', 1, 1.00);",
  );
  await typeLine(page, "UPDATE events SET user_id = 0 WHERE id < 0;");
  await settleQuietly();
  expect(await changes()).toHaveLength(2);
  expect(await screen(page)).toContain("Constraint Error");
  await expect.poll(() => panelNotifications(page)).toBe(2);
  expect(await quietCounts()).toEqual({ loads: 3, reads: 12 });

  // The shell sees what the panel shows.
  expect(await shellOverview(page)).toEqual(await readPanel(page));
  expect(await readPanel(page)).toEqual(expectedOverview(rows));
  expect(await quietCounts()).toEqual({ loads: 3, reads: 12 });
  log.push(`final: ${JSON.stringify(await changes())}`);
  saveEvidence(
    `02-shell-insert-${target}.txt`,
    `${log.join("\n")}\n\n${await screen(page)}\n`,
  );
  await screenshot(page, "02-after-shell-insert");
  expect(problems).toEqual([]);
});

test("reset restores the exact seed: panel, shell and snapshot agree", async ({ page }) => {
  const problems = collectProblems(page);
  await loadPlayground(page);
  await openAnalytics(page);
  const seedSnap = await inst(page, (h) => h.snapshot(), null);
  // The snapshot is the seed itself, row for row.
  expect(Object.keys(seedSnap)).toEqual(["events"]);
  expect(seedSnap.events.columns).toEqual([
    "id",
    "occurred_on",
    "kind",
    "country",
    "source",
    "user_id",
    "revenue",
  ]);
  expect(seedSnap.events.rows).toEqual(
    SEED_EVENTS.map((e) => [
      e.id,
      e.day,
      e.kind,
      e.country,
      e.source,
      e.userId,
      e.revenue,
    ]),
  );

  await openDatabaseView(page);
  for (
    const line of [
      "INSERT INTO events (occurred_on, kind, country, source, user_id) VALUES (DATE '2026-09-20', 'page_view', 'DE', 'social', 7);",
      "DELETE FROM events WHERE country = 'BR';",
      "UPDATE events SET revenue = 1000.00 WHERE kind = 'signup';",
      "CREATE TABLE scratch AS SELECT 1 AS x;",
    ]
  ) await typeLine(page, line);
  await expect.poll(() => inst(page, (h) => h.changes().length, null)).toBe(4);
  expect(await readPanel(page)).not.toEqual(seedOverview);
  expect(await inst(page, (h) => h.snapshot(), null)).not.toEqual(seedSnap);

  // The editor host's Reset (DB0 control on the same service).
  const before = await inst(page, (h) => h.changes().length, null);
  await section(page).getByTestId("db-reset").click();
  await expect(section(page).getByTestId("db-message")).toHaveText(
    "database reset to its seed",
  );
  await panelShows(page, seedOverview);
  expect(await inst(page, (h) => h.snapshot(), null)).toEqual(seedSnap);
  expect((await inst(page, (h) => h.changes(), null)).slice(before)).toEqual([
    { kind: "reset", source: "host", changes: 0, schemaChanged: true },
  ]);
  const tables = await shellQuery(page, "SHOW TABLES;");
  expect(tables.rows).toEqual([["events"]]);
  expect(await shellOverview(page)).toEqual(seedOverview);

  // The sequence is part of the seed: the next shell id is exactly 361.
  await typeLine(
    page,
    "INSERT INTO events (occurred_on, kind, country, source, user_id) VALUES (DATE '2026-09-21', 'page_view', 'DE', 'social', 8);",
  );
  const next = await inst(
    page,
    (h) => h.execute("SELECT max(id) AS id FROM events"),
    null,
  );
  expect(next.rows).toEqual([[361]]);

  // The panel's own Reset (application.reset) gives the same seed.
  await section(page).getByTestId("r6-reset").click();
  await panelShows(page, seedOverview);
  expect(await inst(page, (h) => h.snapshot(), null)).toEqual(seedSnap);
  expect(await shellOverview(page)).toEqual(await readPanel(page));
  // The sequence again (snapshot covers tables only).
  await typeLine(
    page,
    "INSERT INTO events (occurred_on, kind, country, source, user_id) VALUES (DATE '2026-09-22', 'page_view', 'DE', 'social', 9);",
  );
  const afterPanelReset = await inst(
    page,
    (h) => h.execute("SELECT max(id) AS id FROM events"),
    null,
  );
  expect(afterPanelReset.rows).toEqual([[361]]);
  saveEvidence(`03-reset-${target}.txt`, (await screen(page)) + "\n");
  await screenshot(page, "03-after-reset");
  expect(problems).toEqual([]);
});

test("a schema change from the shell shows a typed error; reset recovers", async ({ page }) => {
  const problems = collectProblems(page);
  await loadPlayground(page);
  await openAnalytics(page);
  await openDatabaseView(page);
  await typeLine(page, "ALTER TABLE events RENAME COLUMN kind TO event_kind;");
  await expect(section(page).getByTestId("r6-error")).toContainText(
    "Database error (execute)",
  );
  // One conservative write event (DB1 counts an uncounted write as 1 row).
  const changes = await inst(page, (h) => h.changes(), null);
  expect(changes).toHaveLength(1);
  expect(changes[0]).toMatchObject({
    kind: "write",
    source: "shell",
    schemaChanged: true,
  });
  await typeLine(page, "ALTER TABLE events RENAME COLUMN event_kind TO kind;");
  await typeLine(page, "ALTER TABLE events ALTER revenue TYPE VARCHAR;");
  await typeLine(page, "UPDATE events SET revenue = 'lots' WHERE id = 3;");
  await expect(section(page).getByTestId("r6-error")).toContainText(
    "Database error (execute)",
  );
  await expect(section(page).getByTestId("r6-overview")).toHaveAttribute(
    "data-stale",
    "true",
  );
  await screenshot(page, "04-typed-error");
  await section(page).getByTestId("r6-reset").click();
  await panelShows(page, seedOverview);
  await expect(section(page).getByTestId("r6-error")).toHaveCount(0);
  await expect(section(page).getByTestId("r6-overview")).toHaveAttribute(
    "data-stale",
    "false",
  );
  expect(problems).toEqual([]);
});

test("Q18: while DB1's shell owns the page the Database view says so; after DB1 disposes it opens", async ({ page }) => {
  const problems = collectProblems(page);
  await loadPlayground(page);
  await page.getByTestId("db1-open").click();
  await expect(page.getByTestId("db1-status")).toContainText("engine ready", {
    timeout: 90_000,
  });
  await openAnalytics(page);
  await section(page).getByTestId("r6-db-toggle").click();
  await expect(section(page).getByTestId("r6-db-error")).toContainText(
    "page singleton",
    { timeout: 60_000 },
  );
  // The panel is unaffected.
  expect(await readPanel(page)).toEqual(seedOverview);
  await page.evaluate(() =>
    (globalThis as unknown as {
      __playground: { db1: { dispose(): Promise<void> } };
    }).__playground.db1.dispose()
  );
  await openDatabaseView(page);
  await expect(section(page).getByTestId("r6-db-error")).toHaveCount(0);
  const totals = await shellQuery(page, AGGREGATE_SQL.totals);
  expect(totals.rows[0]?.[0]).toBe(String(seedOverview.totals.events));
  expect(problems).toEqual([]);
});
