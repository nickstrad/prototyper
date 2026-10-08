// D1 browser suite: the SQLite DatabaseService on the Fiddle engine worker.
// Runs against the Vite dev server by default and against a plain static
// server (no COOP/COEP) with PW_TARGET=static (see playwright.config.ts).
import { expect, type Page, test } from "@playwright/test";
import process from "node:process";
import type { SqliteWorkbenchHooks } from "../../packages/database/sqlite-workbench.tsx";

const target = process.env.PW_TARGET ?? "dev";
const out = process.env.PW_OUT ?? "test-results";

type D1Window = { __playground?: { d1?: SqliteWorkbenchHooks } };

// OO1 logs every failing sqlite3_step() to the worker console; the suite
// fails statements on purpose, so those lines are expected.
const EXPECTED = /^sqlite3_step\(\) rc=/;

function collectProblems(page: Page) {
  const problems: string[] = [];
  page.on("console", (m) => {
    if (
      (m.type() === "error" || m.type() === "warning") &&
      !EXPECTED.test(m.text())
    ) problems.push(m.text());
  });
  page.on("pageerror", (e) => problems.push(String(e)));
  return problems;
}

async function open(page: Page, persistence: string) {
  await page.goto(`/?d1-persistence=${persistence}`);
  await page.waitForFunction(() =>
    (globalThis as unknown as D1Window).__playground?.d1 !== undefined
  );
}

for (const persistence of ["memory", "opfs-sahpool"] as const) {
  test(`conformance suite on the Fiddle engine (${persistence})`, async ({ page }) => {
    test.setTimeout(120_000);
    const problems = collectProblems(page);
    // The workbench itself stays on memory so the suite can own the pool.
    await open(page, "memory");
    const outcomes = await page.evaluate(
      (p) =>
        (globalThis as unknown as D1Window).__playground!.d1!.conformance({
          persistence: p,
          fresh: true,
        }),
      persistence,
    );
    console.log(
      `---- conformance fiddle ${persistence} (${target}) ----\n` +
        outcomes.map((o) =>
          `${o.ok ? "ok  " : "FAIL"} ${o.name} (${o.ms}ms)${
            o.error ? `\n${o.error}` : ""
          }`
        ).join("\n"),
    );
    expect(outcomes.length).toBe(10);
    expect(outcomes.filter((o) => !o.ok)).toEqual([]);
    expect(problems).toEqual([]);
  });
}

test("workbench: seeded tables, SQL box, typed error, change events", async ({ page }) => {
  const problems = collectProblems(page);
  await page.goto("/");
  const status = page.getByTestId("d1-status");
  await expect(status).toContainText("persistence opfs-sahpool");
  await expect(status).toContainText("SQLite 3.54.0");
  await expect(page.getByTestId("d1-tables")).toHaveText("tasks");

  await page.getByTestId("d1-tables").getByRole("button", { name: "tasks" })
    .click();
  const result = page.getByTestId("d1-result");
  await expect(result).toContainText("Write the project plan");
  await expect(page.getByTestId("d1-summary")).toHaveText(
    "3 row(s) · changes 0",
  );

  const sql = page.getByTestId("d1-sql");
  await sql.fill(
    "INSERT INTO tasks (title, created_at) VALUES ('From the workbench', '2026-10-08')",
  );
  await page.getByTestId("d1-run").click();
  await expect(page.getByTestId("d1-summary")).toHaveText(
    "0 row(s) · changes 1",
  );
  await expect(status).toContainText("events 1");

  await sql.fill(
    "CREATE TABLE notes (id INTEGER PRIMARY KEY, body BLOB, big INTEGER);" +
      "INSERT INTO notes VALUES (1, x'00ff10', 9007199254740993)",
  );
  await page.getByTestId("d1-run").click();
  await expect(status).toContainText("events 2");
  await expect(page.getByTestId("d1-tables")).toContainText("notes");
  await page.getByTestId("d1-tables").getByRole("button", { name: "notes" })
    .click();
  await expect(result).toContainText("x'00ff10'");
  await expect(result).toContainText("9007199254740993");

  await sql.fill("SELEC nope");
  await page.getByTestId("d1-run").click();
  await expect(page.getByTestId("d1-error")).toContainText(
    "execute: SQLITE_ERROR",
  );
  await expect(page.getByTestId("d1-error")).toContainText("syntax error");
  await expect(status).toContainText("events 2"); // failure: no event

  await page.screenshot({
    path: `${out}/d1-workbench-${target}.png`,
    fullPage: true,
  });
  expect(problems).toEqual([]);
});

test("opfs-sahpool keeps data across a reload", async ({ page }) => {
  const problems = collectProblems(page);
  await open(page, "opfs-sahpool");
  const first = await page.evaluate(async () => {
    const d1 = (globalThis as unknown as D1Window).__playground!.d1!;
    const r = await d1.exec(
      "INSERT INTO tasks (title, created_at) VALUES ('survives reload', 'now')",
    );
    return { changes: r.changes, persistence: d1.service.persistence };
  });
  expect(first.changes).toBe(1);
  expect(first.persistence).toEqual({
    requested: "opfs-sahpool",
    actual: "opfs-sahpool",
  });

  await page.reload();
  await page.waitForFunction(() =>
    (globalThis as unknown as D1Window).__playground?.d1 !== undefined
  );
  const after = await page.evaluate(async () => {
    const d1 = (globalThis as unknown as D1Window).__playground!.d1!;
    const r = await d1.exec("SELECT id, title FROM tasks ORDER BY id");
    return { rows: r.rows, persistence: d1.service.persistence.actual };
  });
  expect(after.persistence).toBe("opfs-sahpool");
  expect(after.rows).toEqual([
    [1, "Write the project plan"],
    [2, "Probe SQLite WASM"],
    [3, "Wire the terminal"],
    [4, "survives reload"],
  ]);
  await expect(page.getByTestId("d1-status")).toContainText(
    "persistence opfs-sahpool",
  );
  expect(problems).toEqual([]);
});

test("scope finalizer terminates the engine worker", async ({ page }) => {
  const problems = collectProblems(page);
  await open(page, "memory");
  const closed: string[] = [];
  page.on("worker", (w) => w.on("close", () => closed.push(w.url())));
  const r = await page.evaluate(() =>
    (globalThis as unknown as D1Window).__playground!.d1!.scopedRun(
      "SELECT count(*) FROM tasks",
    )
  );
  expect(r.rows).toEqual([[3]]);
  expect(r.disposes).toBe(1);
  expect(r.closes).toBe(1);
  expect(r.afterClose).toContain("DatabaseError");
  await expect.poll(() => closed.length).toBe(1);
  expect(problems).toEqual([]);
});

test("shell writes reach the service as change events (update/commit hooks)", async ({ page }) => {
  const problems = collectProblems(page);
  await open(page, "memory");
  const r = await page.evaluate(() =>
    (globalThis as unknown as D1Window).__playground!.d1!.shellBridge(
      [
        "INSERT INTO tasks (title, created_at) VALUES ('from shell', 'now');",
        "SELECT count(*) FROM tasks;",
        "CREATE TABLE shell_made (x);",
        "BEGIN;",
        "INSERT INTO shell_made VALUES (1);",
        "INSERT INTO shell_made VALUES (2);",
        "COMMIT;",
        "UPDATE tasks SET completed = 1 WHERE id = 999;",
      ],
      "SELECT (SELECT title FROM tasks WHERE id = 4), (SELECT count(*) FROM shell_made)",
    )
  );
  console.log(
    "---- shell output on the shared worker ----\n" + r.output.join("\n"),
  );
  expect(r.rows).toEqual([["from shell", 2]]);
  // The service opened the shell's database silently, and the shell itself
  // saw the row count including its own insert.
  expect(r.output.join("\n")).not.toContain("prototyper_open");
  expect(r.output.join("\n")).toContain("4");
  expect(r.events).toEqual([
    { kind: "write", source: "shell", changes: 1, schemaChanged: false },
    { kind: "write", source: "shell", changes: 0, schemaChanged: true },
    { kind: "write", source: "shell", changes: 2, schemaChanged: false },
  ]);
  expect(problems).toEqual([]);
});
