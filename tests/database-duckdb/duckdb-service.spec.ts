// D2 browser suite: the DuckDB DatabaseService on an AsyncDuckDB worker (eh
// bundle, self-hosted extensions). Runs against the Vite dev server by
// default and against a plain static server (no COOP/COEP) with
// PW_TARGET=static. Needs public/vendor/duckdb/ populated first:
//   deno run -A scripts/fetch-duckdb-extensions.ts
import { type BrowserContext, expect, test } from "@playwright/test";
import {
  collectProblems,
  type D2Window,
  inPage,
  ready,
  target,
} from "./helpers.ts";

type Outcome = { name: string; ok: boolean; ms: number; error?: string };

function report(title: string, outcomes: Outcome[]) {
  console.log(
    `---- ${title} (${target}) ----\n` +
      outcomes.map((o) =>
        `${o.ok ? "ok  " : "FAIL"} ${o.name} (${o.ms}ms)${
          o.error ? `\n${o.error}` : ""
        }`
      ).join("\n"),
  );
}

for (const persistence of ["memory", "opfs"] as const) {
  test(`DuckDB conformance suite (${persistence})`, async ({ page }) => {
    test.setTimeout(240_000);
    const problems = collectProblems(page);
    await ready(page);
    const outcomes = await inPage(
      page,
      (h, p) => h.conformance({ persistence: p }),
      persistence,
    );
    report(`conformance duckdb ${persistence}`, outcomes);
    expect(outcomes.length).toBe(11);
    expect(outcomes.filter((o) => !o.ok)).toEqual([]);
    expect(problems).toEqual([]);
  });
}

test("D1's SQLite suite, unchanged, against DuckDB (dialect report)", async ({ page }) => {
  test.setTimeout(240_000);
  await ready(page);
  const outcomes = await inPage(page, (h) => h.d1Conformance(), null);
  report("D1 conformance.ts unchanged on duckdb memory", outcomes);
  expect(outcomes.length).toBe(10);
  // The cases that only assert SQLite dialect facts fail here by design; the
  // DuckDB-dialect port above covers the same behaviour. Pin the split so a
  // change in either suite is noticed.
  expect(
    outcomes.filter((o) => o.ok).map((o) => o.name),
  ).toEqual(D1_CASES_PASSING_ON_DUCKDB);
});

/**
 * Recorded 2026-10-08 (run-20261008-d2-01). The other eight assert SQLite
 * facts: engine "sqlite" and a 3.x version, "no such table" texts, untyped
 * columns (`CREATE TABLE extra (x)`), the "SQLite format 3" export header,
 * typeof() = 'integer' and INTEGER as 64-bit, and `count(*)` as the column
 * name.
 */
const D1_CASES_PASSING_ON_DUCKDB: string[] = [
  "exactly one change event per successful write, none otherwise",
  "changes stream delivers events in order",
];

test("scope finalizer terminates the DuckDB worker", async ({ page }) => {
  const problems = collectProblems(page);
  await ready(page);
  const closed: string[] = [];
  // Only DuckDB workers: in dev, StrictMode also terminates a Fiddle worker.
  page.on("worker", (w) => {
    if (w.url().includes("duckdb")) w.on("close", () => closed.push(w.url()));
  });
  const r = await inPage(
    page,
    (h, sql) => h.scopedRun(sql),
    "SELECT count(*), 9007199254740993::BIGINT FROM tasks",
  );
  expect(r.rows).toEqual([[3, { $type: "bigint", value: "9007199254740993" }]]);
  expect(r.disposes).toBe(1);
  expect(r.closes).toBe(1);
  expect(r.detached).toBe(true);
  expect(r.afterClose).toContain("DatabaseError");
  await expect.poll(() => closed.length).toBe(1);
  expect(closed[0]).toContain("duckdb-browser-eh.worker.js");
  expect(problems).toEqual([]);
});

test("six acquire/release cycles leak no workers or listeners", async ({ page }) => {
  test.setTimeout(120_000);
  const problems = collectProblems(page);
  await page.addInitScript(() => {
    const counts = { add: 0, remove: 0 };
    (globalThis as unknown as { __listeners: typeof counts }).__listeners =
      counts;
    for (const t of [globalThis, document]) {
      const add = t.addEventListener;
      const remove = t.removeEventListener;
      t.addEventListener = function (this: EventTarget, ...a: unknown[]) {
        counts.add++;
        return Reflect.apply(add, this, a);
      };
      t.removeEventListener = function (this: EventTarget, ...a: unknown[]) {
        counts.remove++;
        return Reflect.apply(remove, this, a);
      };
    }
  });
  await ready(page);
  const started: string[] = [];
  const closed: string[] = [];
  page.on("worker", (w) => {
    if (!w.url().includes("duckdb")) return; // the playground's Fiddle workers
    started.push(w.url());
    w.on("close", () => closed.push(w.url()));
  });
  // Warm the module graph, then measure listeners around six cycles.
  await inPage(page, (h) => h.cycles(1), null);
  const listeners = () =>
    page.evaluate(() => ({
      ...(globalThis as unknown as {
        __listeners: { add: number; remove: number };
      }).__listeners,
    }));
  const before = await listeners();
  const versions = await inPage(page, (h) => h.cycles(6), null);
  const after = await listeners();
  expect(versions).toEqual(Array(6).fill("1.4.3:3"));
  await expect.poll(() => closed.length).toBe(7);
  expect(started.length).toBe(7);
  // Window/document listeners added during the cycles net to zero.
  expect(after.add - before.add - (after.remove - before.remove)).toBe(0);
  expect(problems).toEqual([]);
});

test("opfs keeps data across a reload (CHECKPOINT after writes)", async ({ page }) => {
  test.setTimeout(120_000);
  const problems = collectProblems(page);
  await ready(page);
  const first = await inPage(page, async (h) => {
    const info = await h.open({ persistence: "opfs", fresh: true });
    const ins = await h.exec(
      "INSERT INTO tasks (title, created_at) VALUES ('survives reload', 'now')",
    );
    const ddl = await h.exec(
      "CREATE TABLE notes (id INTEGER, big HUGEINT, ts TIMESTAMP)",
    );
    const fill = await h.exec(
      "INSERT INTO notes VALUES (1, 170141183460469231731687303715884105727, TIMESTAMP '2024-01-01 09:00:00.123456')",
    );
    return { info, ins, ddl, fill, events: h.events() };
  }, null);
  expect(first.info.persistence).toEqual({
    requested: "opfs",
    actual: "opfs",
  });
  expect(first.info.path).toBe("opfs://prototyper-page.duckdb");
  expect(first.info.capabilities.persistence).toEqual({ available: true });
  expect(first.ins).toMatchObject({ ok: true, result: { changes: 1 } });
  expect(first.ddl).toMatchObject({
    ok: true,
    result: { schemaChanged: true },
  });
  expect(first.fill).toMatchObject({ ok: true, result: { changes: 1 } });

  // A reload kills the worker without any shutdown hook: only the
  // per-write CHECKPOINT can have saved the data.
  await page.reload();
  await page.waitForFunction(() =>
    (globalThis as unknown as D2Window).__playground?.d2 !== undefined
  );
  const after = await inPage(page, async (h) => {
    const info = await h.open({ persistence: "opfs" });
    return {
      info,
      tasks: await h.exec("SELECT id, title FROM tasks ORDER BY id"),
      notes: await h.exec("SELECT * FROM notes"),
      tables: await h.exec("SHOW TABLES"),
    };
  }, null);
  expect(after.info.persistence.actual).toBe("opfs");
  expect(after.tasks).toEqual({
    ok: true,
    result: {
      columns: ["id", "title"],
      rows: [
        [1, "Write the project plan"],
        [2, "Probe SQLite WASM"],
        [3, "Wire the terminal"],
        [4, "survives reload"],
      ],
      changes: 0,
      schemaChanged: false,
      truncated: false,
    },
  });
  expect(after.notes).toMatchObject({
    ok: true,
    result: {
      rows: [[
        1,
        { $type: "bigint", value: "170141183460469231731687303715884105727" },
        "2024-01-01 09:00:00.123456",
      ]],
    },
  });
  await inPage(page, (h) => h.close(), null);
  expect(problems).toEqual([]);
});

test("a second tab on the same file falls back to memory with a reason", async ({ context }: { context: BrowserContext }) => {
  test.setTimeout(120_000);
  const a = await context.newPage();
  const b = await context.newPage();
  const problems = [...collectProblems(a), ...collectProblems(b)];
  await ready(a);
  await ready(b);
  const first = await inPage(
    a,
    (h) => h.open({ persistence: "opfs", name: "shared", fresh: true }),
    null,
  );
  expect(first.persistence.actual).toBe("opfs");
  const second = await inPage(b, async (h) => {
    const info = await h.open({ persistence: "opfs", name: "shared" });
    return { info, rows: await h.exec("SELECT count(*) FROM tasks") };
  }, null);
  expect(second.info.persistence.requested).toBe("opfs");
  expect(second.info.persistence.actual).toBe("memory");
  expect(second.info.persistence.reason).toMatch(/open in another tab/);
  expect(second.info.capabilities.persistence).toMatchObject({
    available: false,
  });
  expect(second.info.path).toBe(":memory:");
  expect(second.rows).toMatchObject({ ok: true, result: { rows: [[3]] } });
  await inPage(a, (h) => h.close(), null);
  await inPage(b, (h) => h.close(), null);
  expect(problems).toEqual([]);
});

test("extensions and engine load from this origin only (offline)", async ({ page }) => {
  test.setTimeout(120_000);
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
  await ready(page);
  const r = await inPage(page, async (h) => {
    await h.open({ persistence: "memory" });
    const out = {
      json: await h.exec("SELECT to_json({'a': 1, 'b': [1, NULL]}) AS j"),
      write: await h.exec(
        "COPY (SELECT * FROM tasks) TO 'tasks.parquet' (FORMAT parquet)",
      ),
      read: await h.exec(
        "SELECT count(*), max(title) FROM read_parquet('tasks.parquet')",
      ),
      extensions: await h.exec(
        "SELECT extension_name FROM duckdb_extensions() WHERE loaded AND extension_name IN ('json', 'parquet') ORDER BY 1",
      ),
      open: await h.openBlocked(),
    };
    await h.close();
    return out;
  }, null);
  expect(r.json).toMatchObject({
    ok: true,
    result: { rows: [['{"a":1,"b":[1,null]}']] },
  });
  expect(r.write).toMatchObject({ ok: true, result: { changes: 0 } });
  expect(r.read).toMatchObject({
    ok: true,
    result: { rows: [[3, "Write the project plan"]] },
  });
  expect(r.extensions).toMatchObject({
    ok: true,
    result: { rows: [["json"], ["parquet"]] },
  });
  expect(r.open).toContain("AsyncDuckDB.open is blocked");
  expect(blocked).toEqual([]);
  expect(requests).toContain(
    "/vendor/duckdb/extensions/v1.4.3/wasm_eh/json.duckdb_extension.wasm",
  );
  expect(requests).toContain(
    "/vendor/duckdb/extensions/v1.4.3/wasm_eh/parquet.duckdb_extension.wasm",
  );
  expect(requests).toContain("/vendor/duckdb/duckdb-eh.wasm");
  expect(requests.filter((p) => p.includes("mvp"))).toEqual([]);
  expect(problems).toEqual([]);
});

test("a page that does not use DuckDB loads none of its assets", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (r) => requests.push(new URL(r.url()).pathname));
  await ready(page);
  // The dev server keeps an HMR socket open, so "networkidle" never comes;
  // give any stray request time to appear instead.
  await page.waitForTimeout(2000);
  // duckdb-hooks.tsx (the lazy loader, no DuckDB import) is allowed.
  const engine =
    /vendor\/duckdb|@duckdb|duckdb-wasm|apache-arrow|duckdb-(harness|service|engine|cells|conformance)/i;
  expect(requests.filter((p) => engine.test(p))).toEqual([]);
  // ...and loading the harness is what brings the engine in.
  await inPage(page, (h) => h.cycles(1), null);
  expect(requests).toContain("/vendor/duckdb/duckdb-eh.wasm");
});
