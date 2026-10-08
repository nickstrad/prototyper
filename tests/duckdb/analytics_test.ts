// Native checks for the event analytics prototype (R6): the seed is
// deterministic and well-formed, and the application decodes aggregate rows
// into typed values, failing with typed errors (AnalyticsDataError,
// InvalidInput, DatabaseError) instead of defects. The aggregates against a
// real DuckDB run in the browser specs (tests/duckdb/*.spec.ts); here the
// DatabaseService is a stub that answers each AGGREGATE_SQL query.
import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { Effect, Stream } from "effect";
import type {
  Cell,
  DatabaseService,
  QueryResult,
} from "../../packages/core/types.ts";
import { DatabaseError } from "../../packages/database/sqlite-service.ts";
import {
  AGGREGATE_SQL,
  makeEventAnalytics,
} from "../../prototypes/event-analytics/application.ts";
import {
  COUNTRIES,
  EVENTS_SEED_SQL,
  generateEvents,
  SEED_DAYS,
  SEED_EVENT_COUNT,
  SEED_EVENTS,
  SOURCES,
} from "../../prototypes/event-analytics/seed.ts";
import { cents, conversionPct, expectedOverview, money } from "./oracle.ts";

Deno.test("the seed is deterministic and covers the dimensions", () => {
  assertEquals(generateEvents(), SEED_EVENTS);
  assertEquals(JSON.stringify(generateEvents()), JSON.stringify(SEED_EVENTS));
  assertNotEquals(generateEvents(1), SEED_EVENTS);
  assertEquals(SEED_EVENTS.length, SEED_EVENT_COUNT);
  assertEquals(SEED_EVENTS.map((e) => e.id), SEED_EVENTS.map((_, k) => k + 1));
  const days = new Set(SEED_EVENTS.map((e) => e.day));
  assertEquals(days.size, SEED_DAYS);
  assertEquals([...days].sort(), [...days]); // ids follow the days
  assertEquals(
    new Set(SEED_EVENTS.map((e) => e.country)).size,
    COUNTRIES.length,
  );
  assertEquals(new Set(SEED_EVENTS.map((e) => e.source)).size, SOURCES.length);
  for (const e of SEED_EVENTS) {
    assertEquals(e.kind === "signup", e.revenue !== null);
  }
  const signups = SEED_EVENTS.filter((e) => e.kind === "signup").length;
  assert(signups > 20 && signups < 100, `signups ${signups}`);
  // One VALUES tuple per row, explicit ids.
  assertEquals(EVENTS_SEED_SQL.split("\n").length, SEED_EVENT_COUNT + 1);
  assert(EVENTS_SEED_SQL.includes("(360, DATE '2026-09-"));
});

Deno.test("the oracle ranks sources and rounds conversion like DuckDB", () => {
  const o = expectedOverview(SEED_EVENTS);
  assertEquals(o.totals.events, SEED_EVENT_COUNT);
  assertEquals(o.totals.views + o.totals.signups, SEED_EVENT_COUNT);
  assertEquals(o.sources.map((s) => s.source).length, 5);
  for (let k = 1; k < o.sources.length; k++) {
    assert(o.sources[k - 1].events >= o.sources[k].events);
  }
  assertEquals(conversionPct(1, 3), "33.3");
  assertEquals(conversionPct(2, 3), "66.7");
  assertEquals(conversionPct(1, 8), "12.5");
  assertEquals(conversionPct(0, 0), null);
  assertEquals(o.perDay.length, SEED_DAYS);
});

Deno.test("the oracle's money text is exact for negative and small amounts", () => {
  assertEquals(money(-550), "-5.50");
  assertEquals(money(-5), "-0.05");
  assertEquals(money(0), "0.00");
  assertEquals(money(1205), "12.05");
  assertEquals(cents("-5.50"), -550);
  assertEquals(cents("-0.05"), -5);
  assertEquals(cents("29.00"), 2900);
  assertEquals(money(cents("-12.3")), "-12.30");
  // A refund row nets out against a signup.
  const net = expectedOverview([
    {
      day: "2026-09-01",
      kind: "signup",
      country: "US",
      source: "email",
      revenue: "9.99",
    },
    {
      day: "2026-09-01",
      kind: "signup",
      country: "US",
      source: "email",
      revenue: "-29.00",
    },
  ]);
  assertEquals(net.totals.revenue, "-19.01");
});

// ---- the application over a stub service ----------------------------------------

const result = (rows: readonly (readonly Cell[])[]): QueryResult => ({
  columns: [],
  rows,
  changes: 0,
  schemaChanged: false,
  truncated: false,
});

const stub = (
  answer: (sql: string) => QueryResult | DatabaseError,
): DatabaseService => ({
  engine: "duckdb",
  version: "test",
  persistence: { requested: "memory", actual: "memory" },
  capabilities: {
    persistence: { available: false, reason: "stub" },
    multiTab: { available: false, reason: "stub" },
    export: { available: false, reason: "stub" },
    import: { available: false, reason: "stub" },
    cancellation: { available: false, reason: "stub" },
  },
  execute: (sql) => {
    const r = answer(sql);
    return r instanceof DatabaseError ? Effect.fail(r) : Effect.succeed(r);
  },
  tables: () => Effect.succeed(["events"]),
  schema: () => Effect.succeed(""),
  reset: () => Effect.void,
  exportBytes: () => Effect.succeed(new Uint8Array()),
  importBytes: () => Effect.void,
  subscribe: Effect.never,
  changes: Stream.empty,
});

const good = (sql: string): QueryResult => {
  switch (sql) {
    case AGGREGATE_SQL.totals:
      return result([[360, 306, 54, "711.46"]]);
    case AGGREGATE_SQL.eventsPerDay:
      return result([["2026-09-01", 20, 3], [
        "2026-09-02",
        9007199254740993n,
        0,
      ]]);
    case AGGREGATE_SQL.topSources:
      return result([
        ["search", 120, 10, "99.90"],
        ["social", 90, 5, "0.00"],
        ["direct", 70, 9, "29.00"],
      ]);
    case AGGREGATE_SQL.conversionByCountry:
      return result([["BR", 40, 4, "10.0"], ["JP", 0, 2, null]]);
  }
  throw new Error(`unexpected SQL: ${sql}`);
};

const run = <A, E>(e: Effect.Effect<A, E>) =>
  Effect.runPromise(Effect.result(e));

Deno.test("aggregate rows decode into typed values (bigint and decimals kept)", async () => {
  const app = makeEventAnalytics(stub(good));
  assertEquals(app.reads(), 0);
  const o = await run(app.overview());
  assert(o._tag === "Success");
  assertEquals(app.reads(), 4); // one read per aggregate query
  assertEquals(o.success.totals, {
    events: 360,
    views: 306,
    signups: 54,
    revenue: "711.46",
  });
  assertEquals(o.success.perDay[1].views, 9007199254740993n);
  assertEquals(o.success.countries[1], {
    country: "JP",
    views: 0,
    signups: 2,
    conversionPct: null,
  });
  const top = await run(app.topSources(2));
  assert(top._tag === "Success");
  assertEquals(top.success.map((s) => s.source), ["search", "social"]);
});

Deno.test("bad input and unreadable data fail with typed errors", async () => {
  const app = makeEventAnalytics(stub(good));
  for (const bad of [0, 51, 1.5, "3", null]) {
    const r = await run(app.topSources(bad));
    assert(r._tag === "Failure");
    assertEquals(r.failure._tag, "InvalidInput");
  }
  // A column changed type from the shell: the row names itself.
  const altered = makeEventAnalytics(
    stub((sql) =>
      sql === AGGREGATE_SQL.totals
        ? result([[360, "many", 54, "1.00"]])
        : good(sql)
    ),
  );
  const r = await run(altered.overview());
  assert(r._tag === "Failure");
  assertEquals(r.failure._tag, "AnalyticsDataError");
  assert(r.failure.message.startsWith("totals row 1:"), r.failure.message);
  // The table was dropped: D2's DatabaseError passes through, typed.
  const dropped = makeEventAnalytics(stub(() =>
    new DatabaseError({
      operation: "execute",
      message: "Catalog Error: Table with name events does not exist!",
      cause: null,
    })
  ));
  const d = await run(dropped.totals());
  assert(d._tag === "Failure");
  assertEquals(d.failure._tag, "DatabaseError");
  // Two rows where one is expected.
  const twice = makeEventAnalytics(
    stub((sql) =>
      sql === AGGREGATE_SQL.totals
        ? result([[1, 1, 0, "0.00"], [1, 1, 0, "0.00"]])
        : good(sql)
    ),
  );
  const t = await run(twice.totals());
  assert(t._tag === "Failure");
  assertEquals(t.failure._tag, "AnalyticsDataError");
});
