import { expect, type Page, test } from "@playwright/test";
import type { PersistenceHarness } from "./fixture.tsx";
import { TASKS_SEED_ROWS } from "../../../packages/database/sqlite-seed.ts";

type HarnessWindow = { r7: PersistenceHarness };
const path = "/tests/persistence/sqlite/index.html";
async function ready(page: Page) {
  await page.waitForFunction(() =>
    !!(globalThis as unknown as HarnessWindow).r7
  );
  await expect(page.getByTestId("persistence-status")).toBeVisible();
}
async function open(page: Page) {
  const response = await page.goto(path);
  expect(response?.headers()["cross-origin-opener-policy"]).toBeUndefined();
  expect(response?.headers()["cross-origin-embedder-policy"]).toBeUndefined();
  await ready(page);
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(false);
}
const exec = (page: Page, sql: string) =>
  page.evaluate(
    (sql) => (globalThis as unknown as HarnessWindow).r7.exec(sql),
    sql,
  );
const reset = (page: Page) =>
  page.evaluate(() => (globalThis as unknown as HarnessWindow).r7.reset());
const persistent = (page: Page) =>
  expect(page.getByTestId("persistence-status")).toHaveText(
    "persistence.actual: opfs-sahpool",
  );

test("reload retention on the Fiddle service without headers", async ({ page }) => {
  await open(page);
  await persistent(page);
  await exec(page, "INSERT INTO tasks VALUES (40, 'retained', 0, 'fixed')");
  await page.reload();
  await ready(page);
  await persistent(page);
  expect(await exec(page, "SELECT * FROM tasks WHERE id = 40")).toMatchObject({
    rows: [[40, "retained", 0, "fixed"]],
  });
});

test(
  "fallback reason identifies the actual second-tab lock; memory stays isolated",
  async ({ page, context }, info) => {
    await open(page);
    await persistent(page);
    await exec(page, "INSERT INTO tasks VALUES (40, 'owner only', 0, 'fixed')");
    const second = await context.newPage();
    await open(second);
    const persistence = await second.evaluate(() =>
      (globalThis as unknown as HarnessWindow).r7.persistence
    );
    expect(persistence.actual).toBe("memory");
    expect(persistence.reason).toMatch(
      /another tab|NoModificationAllowedError|Access Handles|access handle|locked/i,
    );
    await expect(second.getByTestId("persistence-status")).toHaveText(
      `persistence.actual: memory-fallback (${persistence.reason})`,
    );
    expect(await exec(second, "SELECT * FROM tasks ORDER BY id")).toMatchObject(
      { rows: TASKS_SEED_ROWS },
    );
    await exec(second, "DELETE FROM tasks");
    await reset(second);
    expect(await exec(second, "SELECT * FROM tasks ORDER BY id")).toMatchObject(
      { rows: TASKS_SEED_ROWS },
    );
    expect(await exec(page, "SELECT title FROM tasks WHERE id = 40"))
      .toMatchObject({ rows: [["owner only"]] });
    await second.screenshot({ path: info.outputPath("fallback-wide.png") });
    await second.setViewportSize({ width: 320, height: 720 });
    await second.screenshot({ path: info.outputPath("fallback-narrow.png") });
    expect(
      await second.evaluate(() =>
        document.documentElement.scrollWidth <= innerWidth
      ),
    ).toBe(true);
    await page.close();
    await second.reload();
    await ready(second);
    await persistent(second);
    expect(await exec(second, "SELECT title FROM tasks WHERE id = 40"))
      .toMatchObject({ rows: [["owner only"]] });
  },
);

test("deterministic reset restores schema and complete seed across reload", async ({ page }) => {
  await open(page);
  await persistent(page);
  for (let i = 0; i < 2; i++) {
    await exec(
      page,
      "DELETE FROM tasks; CREATE TABLE extra (x); INSERT INTO extra VALUES (7)",
    );
    await reset(page);
    expect(await exec(page, "SELECT * FROM tasks ORDER BY id")).toMatchObject({
      rows: TASKS_SEED_ROWS,
    });
    expect(
      await exec(
        page,
        "SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name",
      ),
    ).toMatchObject({ rows: [["tasks"]] });
  }
  await page.reload();
  await ready(page);
  await persistent(page);
  expect(await exec(page, "SELECT * FROM tasks ORDER BY id")).toMatchObject({
    rows: TASKS_SEED_ROWS,
  });
});
