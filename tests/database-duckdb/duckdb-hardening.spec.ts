// D2 review-01 fixes: crafted import images, statement classification
// (TRUNCATE, EXPLAIN ANALYZE, PREPARE/EXECUTE), CHECKPOINT failures and
// explicit transactions on OPFS, committed-only export. Same targets and
// prerequisites as duckdb-service.spec.ts.
import { expect, test } from "@playwright/test";
import { collectProblems, type D2Window, inPage, ready } from "./helpers.ts";

const write = (changes: number, schemaChanged = false) => ({
  kind: "write",
  source: "app",
  changes,
  schemaChanged,
});

test("crafted import images are refused before any statement runs", async ({ page }) => {
  test.setTimeout(180_000);
  const problems = collectProblems(page);
  await ready(page);
  const r = await inPage(page, async (h) => {
    await h.open({ persistence: "memory" });
    await h.exportImage();
    await h.exec("INSERT INTO tasks (title, created_at) VALUES ('kept', 'x')");
    const probes = [
      { file: "schema.sql", append: "\nATTACH ':memory:' AS sneaky;\n" },
      {
        file: "schema.sql",
        append:
          "\nSET custom_extension_repository = 'http://203.0.113.9/ext';\n",
      },
      {
        file: "load.sql",
        append:
          "SET enable_external_file_cache = true; SELECT error('boom');\n",
      },
      { file: "schema.sql", append: "\nCREATE TABLE evil AS SELECT 1 AS x;\n" },
      {
        file: "load.sql",
        append:
          "COPY tasks FROM 'elsewhere/tasks.parquet' (FORMAT 'parquet');\n",
      },
      // Review 02: CTAS behind a column list or in brackets, and enums
      // backed by VALUES or FROM queries.
      { file: "schema.sql", append: "\nCREATE TABLE evil (a) AS SELECT 1;\n" },
      {
        file: "schema.sql",
        append: "\nCREATE TABLE evil AS (SELECT 1 AS x);\n",
      },
      {
        file: "schema.sql",
        append: "\nCREATE TYPE evil AS ENUM (VALUES ('a'), ('b'));\n",
      },
      {
        file: "schema.sql",
        append: "\nCREATE TYPE evil AS ENUM (FROM tasks);\n",
      },
    ] as const;
    const out = [];
    for (const p of probes) out.push(await h.importImage(p));
    const benign = await h.importImage();
    await h.close();
    return { out, benign };
  }, null);
  for (const probe of r.out) {
    expect(probe.outcome).toMatch(
      /^DatabaseError\(import\): refused DuckDB export image: /,
    );
    // Nothing ran: no attached database, settings untouched, data kept.
    expect(probe.state).toMatchObject({
      ok: true,
      result: {
        rows: [[
          1,
          expect.stringMatching(/\/vendor\/duckdb\/extensions$/),
          0,
          4,
        ]],
      },
    });
  }
  expect(r.out.map((p) => p.outcome)).toEqual([
    expect.stringContaining(
      "schema.sql contains a statement other than CREATE: ATTACH",
    ),
    expect.stringContaining(
      "schema.sql contains a statement other than CREATE: SET",
    ),
    expect.stringContaining("load.sql contains a statement other than COPY"),
    expect.stringContaining("CREATE TABLE … AS"),
    expect.stringContaining("load.sql contains a statement other than COPY"),
    expect.stringContaining("CREATE TABLE … AS"),
    expect.stringContaining("CREATE TABLE … AS"),
    expect.stringContaining("a query-backed type"),
    expect.stringContaining("a query-backed type"),
  ]);
  expect(r.benign.outcome).toBe("imported");
  expect(r.benign.state).toMatchObject({
    ok: true,
    result: { rows: [[1, expect.any(String), 0, 3]] },
  });
  expect(problems).toEqual([]);
});

test("benign image with every exported object kind round-trips", async ({ page }) => {
  test.setTimeout(120_000);
  const problems = collectProblems(page);
  await ready(page);
  const r = await inPage(page, async (h) => {
    await h.open({ persistence: "memory" });
    await h.exec(`CREATE SCHEMA side;
      CREATE TYPE mood AS ENUM ('ok', 'sad');
      CREATE TABLE side."odd name" (m mood, n INTEGER CHECK (n > 0));
      INSERT INTO side."odd name" VALUES ('sad', 7);
      CREATE UNIQUE INDEX tasks_title ON tasks(title);
      CREATE VIEW open_tasks AS SELECT * FROM tasks WHERE completed = 0;
      CREATE MACRO twice(x) AS x * 2;
      CREATE MACRO pick(n) AS TABLE SELECT * FROM tasks WHERE id = n;`);
    await h.exportImage();
    await h.exec('DROP VIEW open_tasks; DROP TABLE side."odd name"');
    const imported = await h.importImage();
    const check = await h.exec(`SELECT
      (SELECT count(*) FROM open_tasks),
      twice(21),
      (SELECT title FROM pick(2)),
      (SELECT m || ':' || n FROM side."odd name"),
      (SELECT count(*) FROM duckdb_indexes() WHERE index_name = 'tasks_title')`);
    await h.close();
    return { imported, check };
  }, null);
  expect(r.imported.outcome).toBe("imported");
  expect(r.check).toMatchObject({
    ok: true,
    result: { rows: [[2, 42, "Probe SQLite WASM", "sad:7", 1]] },
  });
  expect(problems).toEqual([]);
});

test("TRUNCATE, EXPLAIN ANALYZE <write> and PREPARE/EXECUTE are classified", async ({ page }) => {
  test.setTimeout(120_000);
  const problems = collectProblems(page);
  await ready(page);
  const r = await inPage(page, async (h) => {
    await h.open({ persistence: "memory" });
    const ins = "INSERT INTO tasks (title, created_at) VALUES ('t', 'x')";
    const out = {
      truncate: await h.exec("TRUNCATE tasks"),
      explain: await h.exec(`EXPLAIN ANALYZE ${ins}`),
      explainRead: await h.exec("EXPLAIN ANALYZE SELECT * FROM tasks"),
      prepare: await h.exec(`PREPARE p AS ${ins}`),
      execute: await h.exec("EXECUTE p"),
      prepareQ: await h.exec("PREPARE q AS SELECT 42 AS x"),
      executeQ: await h.exec("EXECUTE q"),
      prepareR: await h.exec(`PREPARE r AS ${ins} RETURNING title`),
      executeR: await h.exec("EXECUTE r"),
      deallocate: await h.exec("DEALLOCATE p"),
      count: await h.exec("SELECT count(*) FROM tasks"),
      events: [] as unknown[],
    };
    out.events = [...h.events()];
    await h.close();
    return out;
  }, null);
  expect(r.truncate).toMatchObject({ ok: true, result: { changes: 3 } });
  expect(r.explain).toMatchObject({
    ok: true,
    result: { columns: ["explain_key", "explain_value"], changes: 0 },
  });
  expect(r.explainRead).toMatchObject({ ok: true, result: { changes: 0 } });
  expect(r.execute).toMatchObject({ ok: true, result: { changes: 1 } });
  expect(r.executeQ).toMatchObject({
    ok: true,
    result: { columns: ["x"], rows: [[42]], changes: 0 },
  });
  expect(r.executeR).toMatchObject({
    ok: true,
    result: { columns: ["title"], rows: [["t"]], changes: 1 },
  });
  expect(r.count).toMatchObject({ ok: true, result: { rows: [[3]] } });
  // TRUNCATE, EXPLAIN ANALYZE INSERT (no row count: changes 0), EXECUTE p,
  // EXECUTE r; nothing for the reads, PREPAREs or DEALLOCATE.
  expect(r.events).toEqual([write(3), write(0), write(1), write(1)]);
  expect(problems).toEqual([]);
});

test("OPFS: explicit transactions survive, commit and persist", async ({ page }) => {
  test.setTimeout(120_000);
  const problems = collectProblems(page);
  await ready(page);
  const first = await inPage(page, async (h) => {
    await h.open({ persistence: "opfs", fresh: true, name: "txn" });
    const out = {
      begin: await h.exec("BEGIN"),
      ins: await h.exec(
        "INSERT INTO tasks (title, created_at) VALUES ('in txn', 'x')",
      ),
      // Before the fix the service's own CHECKPOINT aborted the transaction.
      sees: await h.exec("SELECT count(*) FROM tasks"),
      commit: await h.exec("COMMIT"),
      explain: await h.exec(
        "EXPLAIN ANALYZE INSERT INTO tasks (title, created_at) VALUES ('explained', 'x')",
      ),
    };
    return out;
  }, null);
  expect(first.ins).toMatchObject({ ok: true, result: { changes: 1 } });
  expect(first.sees).toMatchObject({ ok: true, result: { rows: [[4]] } });
  expect(first.commit).toMatchObject({ ok: true });
  expect(first.explain).toMatchObject({ ok: true });
  await page.reload();
  await page.waitForFunction(() =>
    (globalThis as unknown as D2Window).__playground?.d2 !== undefined
  );
  const after = await inPage(page, async (h) => {
    await h.open({ persistence: "opfs", name: "txn" });
    const titles = await h.exec(
      "SELECT title FROM tasks WHERE id > 3 ORDER BY id",
    );
    await h.close();
    return titles;
  }, null);
  expect(after).toMatchObject({
    ok: true,
    result: { rows: [["in txn"], ["explained"]] },
  });
  expect(problems).toEqual([]);
});

test("CHECKPOINT failures surface; another writer's open transaction does not", async ({ page }) => {
  test.setTimeout(120_000);
  const problems = collectProblems(page);
  await ready(page);
  const r = await inPage(page, async (h) => {
    await h.open({ persistence: "opfs", fresh: true, name: "ckpt" });
    h.injectCheckpointFailures(1);
    const failed = await h.exec(
      "INSERT INTO tasks (title, created_at) VALUES ('not persisted', 'x')",
    );
    const next = await h.exec(
      "INSERT INTO tasks (title, created_at) VALUES ('persisted', 'x')",
    );
    const shellOpen = await h.withOtherTransaction(
      "INSERT INTO tasks (title, created_at) VALUES ('shell', 'x')",
      "UPDATE tasks SET completed = 1 WHERE id = 1",
    );
    const events = [...h.events()];
    await h.close();
    return { failed, next, shellOpen, events };
  }, null);
  expect(r.failed).toEqual({
    ok: false,
    error: expect.stringMatching(
      /^DatabaseError\(execute\): write applied but not persisted: CHECKPOINT failed: injected CHECKPOINT I\/O failure/,
    ),
  });
  expect(r.next).toMatchObject({ ok: true, result: { changes: 1 } });
  expect(r.shellOpen).toMatchObject({ ok: true, result: { changes: 1 } });
  // The failed CHECKPOINT still reports the applied write.
  expect(r.events).toEqual([write(1), write(1), write(1)]);
  expect(problems).toEqual([]);
});

test("exportBytes holds committed data only", async ({ page }) => {
  test.setTimeout(120_000);
  const problems = collectProblems(page);
  await ready(page);
  const r = await inPage(page, async (h) => {
    await h.open({ persistence: "memory" });
    await h.exec("BEGIN");
    await h.exec("INSERT INTO tasks (title, created_at) VALUES ('open', 'x')");
    await h.exportImage();
    await h.exec("COMMIT");
    const imported = await h.importImage();
    await h.close();
    return imported;
  }, null);
  expect(r.outcome).toBe("imported");
  expect(r.state).toMatchObject({
    ok: true,
    result: { rows: [[1, expect.any(String), 0, 3]] },
  });
  expect(problems).toEqual([]);
});

test("a failed re-PREPARE keeps the earlier statement's kind", async ({ page }) => {
  test.setTimeout(120_000);
  const problems = collectProblems(page);
  await ready(page);
  const r = await inPage(page, async (h) => {
    await h.open({ persistence: "memory" });
    const out = {
      prepare: await h.exec(
        "PREPARE p AS INSERT INTO tasks (title, created_at) VALUES ('p', 'x')",
      ),
      // Fails in DuckDB, which keeps the earlier `p`.
      reprepare: await h.exec("PREPARE p AS SELECT * FROM nope"),
      execute: await h.exec("EXECUTE p"),
      // PREPARE and EXECUTE in one script.
      script: await h.exec(
        "PREPARE q AS INSERT INTO tasks (title, created_at) VALUES ('q', 'x'); EXECUTE q",
      ),
      count: await h.exec("SELECT count(*) FROM tasks"),
      events: [] as unknown[],
    };
    out.events = [...h.events()];
    await h.close();
    return out;
  }, null);
  expect(r.reprepare).toMatchObject({ ok: false });
  expect(r.execute).toMatchObject({ ok: true, result: { changes: 1 } });
  expect(r.script).toMatchObject({ ok: true, result: { changes: 1 } });
  expect(r.count).toMatchObject({ ok: true, result: { rows: [[5]] } });
  expect(r.events).toEqual([write(1), write(1)]);
  expect(problems).toEqual([]);
});
