// DB1: the upstream DuckDB shell and the application share one live
// instance (D2's AsyncDuckDB), both directions. Shell writes reach the
// service's change stream through publishExternal and refresh subscribed
// views (the workbench's app view and the host's table list and preview).
import { expect, type Page, test } from "@playwright/test";
import {
  collectProblems,
  db1,
  focusShell,
  openDuckDb,
  outputOf,
  saveEvidence,
  screen,
  screenshot,
  target,
  typeLine,
} from "./helpers.ts";

test.describe.configure({ timeout: 120_000 });

/** DB1's section (DB0's editor on the same page uses the same test ids). */
const host = (page: Page) => page.getByTestId("db1-workbench");

const changes = (page: Page) => db1(page, (h) => [...h.changes], null);

test("an app write is visible in the shell", async ({ page }) => {
  const problems = collectProblems(page);
  await openDuckDb(page);
  const inserted = await db1(
    page,
    (h) =>
      h.execute(
        "INSERT INTO tasks (title, created_at) VALUES ('from the app', '2026-10-08')",
      ),
    null,
  );
  expect(inserted.changes).toBe(1);
  await focusShell(page);
  const line = "SELECT id, title FROM tasks WHERE title = 'from the app';";
  await typeLine(page, line);
  const out = outputOf(await screen(page), line);
  expect(out).toMatch(/│\s+4 ┆ from the app │/);
  // DDL from the app as well.
  await db1(
    page,
    (h) => h.execute("CREATE TABLE app_made AS SELECT 7 AS seven"),
    null,
  );
  await typeLine(page, "SHOW TABLES;");
  expect(outputOf(await screen(page), "SHOW TABLES;")).toContain("app_made");
  saveEvidence(
    `04-app-to-shell-${target}.txt`,
    `${line}\n${out}\nSHOW TABLES;\n${
      outputOf(await screen(page), "SHOW TABLES;")
    }`,
  );
  expect(problems).toEqual([]);
});

test("a shell write is visible to the service and refreshes subscribed views", async ({ page }) => {
  const problems = collectProblems(page);
  await openDuckDb(page);
  const appView = page.getByTestId("db1-app-view");
  await expect(appView).toContainText("3: Wire the terminal");
  expect(await changes(page)).toEqual([]);

  // Reads, no-op writes and failures publish nothing.
  await typeLine(page, "SELECT count(*) FROM tasks;");
  await typeLine(page, "UPDATE tasks SET title = 'x' WHERE id = 999;");
  await typeLine(page, "INSERT INTO missing VALUES (1);");
  expect(await changes(page)).toEqual([]);

  // DML: one write event from the shell with DuckDB's own row count.
  await typeLine(
    page,
    "INSERT INTO tasks (title, created_at) VALUES ('typed in the shell', 'now');",
  );
  expect(await changes(page)).toEqual([
    { kind: "write", source: "shell", changes: 1, schemaChanged: false },
  ]);
  const seen = await db1(
    page,
    (h) =>
      h.execute(
        "SELECT id, title FROM tasks WHERE title = 'typed in the shell'",
      ),
    null,
  );
  expect(seen.rows).toEqual([[4, "typed in the shell"]]);
  // The subscribed app view and the host's row preview refreshed.
  await expect(appView).toContainText("4: typed in the shell");
  await expect(host(page).getByTestId("db-preview")).toContainText(
    "typed in the shell",
  );
  await expect(host(page).getByTestId("db-last-change")).toHaveText(
    "last change: write from shell (1 rows)",
  );

  // UPDATE of several rows: the count is the shell's own.
  await typeLine(page, "UPDATE tasks SET completed = 1 WHERE completed = 0;");
  expect((await changes(page)).at(-1)).toEqual({
    kind: "write",
    source: "shell",
    changes: 3,
    schemaChanged: false,
  });

  // DDL: schemaChanged from a catalog diff; the host's table list refreshes.
  await typeLine(page, "CREATE TABLE shell_notes (id INTEGER, body VARCHAR);");
  expect((await changes(page)).at(-1)).toMatchObject({
    source: "shell",
    schemaChanged: true,
  });
  await expect(host(page).getByTestId("db-tables")).toContainText(
    "shell_notes",
  );
  expect(await db1(page, (h) => h.tables(), null)).toEqual([
    "shell_notes",
    "tasks",
  ]);

  // A shell transaction: invisible to the app until COMMIT (separate
  // connections, normal isolation), then one more event.
  await typeLine(page, "BEGIN;");
  await typeLine(page, "INSERT INTO shell_notes VALUES (1, 'pending');");
  const during = await db1(
    page,
    (h) => h.execute("SELECT count(*) FROM shell_notes"),
    null,
  );
  expect(during.rows).toEqual([[0]]);
  const before = (await changes(page)).length;
  await typeLine(page, "COMMIT;");
  const committed = await db1(
    page,
    (h) => h.execute("SELECT body FROM shell_notes"),
    null,
  );
  expect(committed.rows).toEqual([["pending"]]);
  expect((await changes(page)).length).toBeGreaterThan(before);
  expect((await changes(page)).every((c) => c.source === "shell")).toBe(true);

  saveEvidence(
    `05-shell-to-app-${target}.txt`,
    `${await screen(page)}\n\n# change events\n${
      JSON.stringify(await changes(page), null, 2)
    }\n`,
  );
  await screenshot(page, "05-shell-to-app");
  expect(
    await db1(page, (h) => h.runtime!.binding.reportErrors.length, null),
  ).toBe(0);
  expect(problems).toEqual([]);
});

test("a host reset keeps the shell bound to the same instance", async ({ page }) => {
  const problems = collectProblems(page);
  await openDuckDb(page);
  await typeLine(page, "DELETE FROM tasks;");
  await expect(page.getByTestId("db1-app-view")).not.toContainText(
    "Wire the terminal",
  );
  await host(page).getByTestId("db-reset").click();
  await expect(host(page).getByTestId("db-message")).toHaveText(
    "database reset to its seed",
  );
  await expect(page.getByTestId("db1-app-view")).toContainText(
    "3: Wire the terminal",
  );
  await focusShell(page);
  await typeLine(page, "SELECT count(*) AS n FROM tasks;");
  expect(outputOf(await screen(page), "SELECT count(*) AS n FROM tasks;"))
    .toMatch(/│\s+3 │/);
  expect(problems).toEqual([]);
});
