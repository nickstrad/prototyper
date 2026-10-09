import { expect, type Page, test } from "@playwright/test";
import type {} from "./fixture.ts";
const ready = (page: Page) => page.waitForFunction(() => !!globalThis.r8);
async function open(page: Page, engine = "sqlite") {
  await page.goto(`/tests/transfer/index.html?engine=${engine}`);
  await ready(page);
}

test("SQLite round-trip fidelity preserves schema, null, bigint, blob and Unicode", async ({ page }) => {
  await open(page);
  const result = await page.evaluate(async () => {
    await r8.exec(
      "INSERT INTO records VALUES (2, 'λ😀', NULL, X''); CREATE INDEX labels ON records(label); CREATE VIEW labels_view AS SELECT label FROM records",
    );
    const before = await r8.snapshot();
    const file = await r8.save();
    await r8.exec(
      "DELETE FROM records; DROP VIEW labels_view; DROP INDEX labels; CREATE TABLE extra(x)",
    );
    await r8.restore();
    return {
      before,
      after: await r8.snapshot(),
      file,
      schema: await r8.exec("SELECT name FROM sqlite_schema ORDER BY name"),
    };
  });
  expect(result.file.name).toBe("database.sqlite3");
  expect(result.file.length).toBeGreaterThan(512);
  expect(result.after).toEqual(result.before);
  expect(result.schema.rows).toEqual([["labels"], ["labels_view"], [
    "records",
  ]]);
  await page.evaluate(() => r8.close());
});

test("corrupt-import snapshot restore preserves latest live data and usability", async ({ page }) => {
  await open(page);
  const result = await page.evaluate(async () => {
    await r8.save();
    await r8.exec(
      "INSERT INTO records VALUES (2, 'latest unsaved', NULL, NULL)",
    );
    const before = await r8.snapshot();
    const error = await r8.corrupt();
    const after = await r8.snapshot();
    const shell = await r8.shell();
    await r8.exec("INSERT INTO records VALUES (3, 'still writable', 3, NULL)");
    return { before, after, error, shell, cache: r8.cached() };
  });
  expect(result.error).toContain("Import failed");
  expect(result.after).toEqual(result.before);
  expect(result.cache.cached).toEqual(result.before);
  expect(result.cache.refreshes).toBe(2);
  expect(result.shell).toMatchObject({
    rows: [expect.anything(), [2, "latest unsaved", null, null]],
  });
  await page.evaluate(() => r8.close());
});

for (const engine of ["sqlite", "duckdb"]) {
  test(`${engine} active interface reconnect and existing shell survive import`, async ({ page }) => {
    await open(page, engine);
    const result = await page.evaluate(async () => {
      const before = await r8.snapshot();
      await r8.save();
      await r8.exec("UPDATE records SET label = 'changed'");
      await r8.restore();
      const cache = r8.cached();
      const shell = await r8.shell();
      await r8.exec("UPDATE records SET label = 'after import'");
      return { before, cache, shell, writable: await r8.snapshot() };
    });
    expect(result.cache.refreshes).toBe(2);
    expect(result.cache.cached).toEqual(result.before);
    expect(JSON.stringify(result.shell)).toContain("seed");
    expect(JSON.stringify(result.writable)).toContain("after import");
    await page.evaluate(() => r8.close());
  });
}

test("DuckDB OPFS CHECKPOINT survives abrupt reload and explicit transaction commit", async ({ page }) => {
  await open(page, "duckdb");
  const first = await page.evaluate(async () => {
    const before = r8.checkpoints();
    await r8.exec(
      "BEGIN; INSERT INTO records VALUES (2, 'reload marker', 17, NULL); COMMIT",
    );
    return {
      before,
      after: r8.checkpoints(),
      persistence: r8.persistence,
      path: r8.path,
    };
  });
  await page.reload(); // no close/finalizer: persistence must precede navigation
  await ready(page);
  expect(
    await page.evaluate(() => r8.exec("SELECT label FROM records WHERE id=2")),
  ).toMatchObject({ rows: [["reload marker"]] });
  expect(first.after - first.before).toBe(1); // completed real CHECKPOINT SQL
  expect(first.persistence).toEqual({ requested: "opfs", actual: "opfs" });
  expect(first.path).toBe("opfs://prototyper-r8-transfer.duckdb");
  await page.evaluate(() => r8.close());
});

test("DuckDB Parquet COPY returns readable bytes and cleans up virtual files", async ({ page }) => {
  await open(page, "duckdb");
  await page.evaluate(() =>
    r8.exec('CREATE TABLE "odd"".table" AS SELECT * FROM records')
  );
  const result = await page.evaluate(() => r8.parquet());
  expect(result.magic).toBe("PAR1");
  expect(result.result.rows).toEqual([[1, "seed", {
    $type: "bigint",
    value: "9007199254740993",
  }, { $type: "blob", base64: "AP8=" }]]);
  expect(result.leftovers).toBe(0);
  await page.evaluate(() => r8.close());
});

test("DuckDB persistence fallback exposes the actual second-tab lock", async ({ page, context }) => {
  await open(page, "duckdb");
  const second = await context.newPage();
  await open(second, "duckdb");
  expect(await second.evaluate(() => r8.persistence)).toMatchObject({
    requested: "opfs",
    actual: "memory",
    reason: expect.stringMatching(/another tab|access handle/i),
  });
  expect(await second.evaluate(() => r8.capabilities.persistence.available))
    .toBe(false);
  await second.evaluate(() => r8.close());
  await page.evaluate(() => r8.close());
});
