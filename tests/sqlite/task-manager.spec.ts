// R1 browser suite: the task manager in the playground, running on the SQLite
// workbench's DatabaseService (D1, Fiddle engine worker; one engine for both
// panels). The UI must re-render from the `changes` stream only: actions
// never refresh the list themselves, writes that bypass the application on
// the same DatabaseService appear (hook `externalWrite`, i.e.
// `service.execute(sql, {source: "shell"})`, and the workbench's SQL box),
// and an idle page performs no reloads. The DB0 sqlite3 shell panel runs its
// own engine today, so its writes are NOT exercised or claimed here.
import { expect, type Page, test } from "@playwright/test";
import process from "node:process";
import type { TaskManagerHooks } from "../../prototypes/task-manager/App.tsx";
import { SEED_TASKS } from "../../prototypes/task-manager/seed.ts";

const out = process.env.PW_OUT ?? "test-results";
const target = process.env.PW_TARGET ?? "dev";

type R1Window = {
  __playground?: { r1?: TaskManagerHooks; d1?: { service: unknown } };
};

// OO1 logs every failing sqlite3_step() to the worker console; D1's suite
// fails statements on purpose in the same page, so those lines are expected.
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

/** Default page: the workbench (and so the task manager) on opfs-sahpool. */
async function open(page: Page, query = "") {
  await page.goto(`/${query}`);
  await page.waitForFunction(
    () => (globalThis as unknown as R1Window).__playground?.r1 !== undefined,
    undefined,
    { timeout: 45_000 },
  );
}

const loads = (page: Page) =>
  page.evaluate(() =>
    (globalThis as unknown as R1Window).__playground!.r1!.loads()
  );

const titles = (page: Page) =>
  page.getByTestId("r1-tasks").getByTestId("r1-task-title").allTextContents();

test("CRUD through the UI, typed errors, reset to seed", async ({ page }) => {
  const problems = collectProblems(page);
  await open(page);
  const status = page.getByTestId("r1-status");
  await expect(status).toContainText(
    "SQLite 3.54.0 · persistence opfs-sahpool",
  );
  await expect(status).toContainText("loads 1");
  expect(await titles(page)).toEqual(SEED_TASKS.map((t) => t.title));
  await expect(page.getByTestId("r1-task-1")).toHaveAttribute(
    "data-completed",
    "true",
  );

  // Create: trimmed title, input cleared, list updated by the change event.
  await page.getByTestId("r1-title").fill("  Ship the task manager  ");
  await page.getByTestId("r1-add").click();
  await expect(page.getByTestId("r1-task-4")).toContainText(
    "Ship the task manager",
  );
  await expect(page.getByTestId("r1-title")).toHaveValue("");
  await expect(status).toContainText("loads 2");
  await expect(status).toContainText("last change: write from app (1 row)");

  // InvalidInput: shown, nothing written, no reload.
  await page.getByTestId("r1-title").fill("   ");
  await page.getByTestId("r1-add").click();
  await expect(page.getByTestId("r1-error")).toHaveText(
    "Invalid input: title is required",
  );
  await expect(page.getByTestId("r1-task-5")).toHaveCount(0);
  expect(await loads(page)).toBe(2);

  // Complete, reopen, rename, delete. The checkbox is controlled by the
  // stream-driven list (no optimistic update), so click rather than check().
  const task2 = page.getByTestId("r1-task-2");
  await task2.getByRole("checkbox").click();
  await expect(task2).toHaveAttribute("data-completed", "true");
  await expect(page.getByTestId("r1-error")).toHaveCount(0);
  await task2.getByRole("checkbox").click();
  await expect(task2).toHaveAttribute("data-completed", "false");
  await page.getByRole("button", { name: "Rename task 3" }).click();
  await page.getByTestId("r1-edit-title").fill("x".repeat(201));
  await page.getByTestId("r1-save").click();
  await expect(page.getByTestId("r1-error")).toHaveText(
    "Invalid input: title must be at most 200 characters",
  );
  await page.getByTestId("r1-edit-title").fill("Wire the CLI");
  await page.getByTestId("r1-save").click();
  await expect(page.getByTestId("r1-task-3")).toContainText("Wire the CLI");
  await page.getByRole("button", { name: "Delete task 1" }).click();
  await expect(page.getByTestId("r1-task-1")).toHaveCount(0);
  expect(await titles(page)).toEqual([
    "Probe SQLite WASM",
    "Wire the CLI",
    "Ship the task manager",
  ]);
  await page.screenshot({
    path: `${out}/r1-task-manager-${target}.png`,
    fullPage: true,
  });
  await page.getByTestId("r1-task-manager").screenshot({
    path: `${out}/r1-task-manager-panel-${target}.png`,
  });

  // Reset returns exactly the seed (via the change stream, kind reset).
  await page.getByTestId("r1-reset").click();
  await expect(status).toContainText("last change: reset by host");
  expect(await titles(page)).toEqual(SEED_TASKS.map((t) => t.title));
  expect(problems).toEqual([]);
});

test("core on the Fiddle engine: RETURNING CRUD and tagged errors", async ({ page }) => {
  const problems = collectProblems(page);
  await open(page, "?d1-persistence=memory");
  const outcome = await page.evaluate(async () => {
    const pg = (globalThis as unknown as R1Window).__playground!;
    const r1 = pg.r1!;
    return {
      shared: r1.service === pg.d1?.service,
      persistence: r1.service.persistence.actual,
      list: await r1.run((a) => a.listTasks()),
      created: await r1.run((a) => a.createTask("O'Brien ☃")),
      completed: await r1.run((a) => a.completeTask(4)),
      updated: await r1.run((a) =>
        a.updateTask(4, { title: "renamed", completed: false })
      ),
      deleted: await r1.run((a) => a.deleteTask(4)),
      missing: await r1.run((a) => a.deleteTask(4)),
      missingComplete: await r1.run((a) => a.completeTask(999)),
      emptyTitle: await r1.run((a) => a.createTask("")),
      badId: await r1.run((a) => a.completeTask(1.5)),
      badPatch: await r1.run((a) => a.updateTask(1, {})),
      after: await r1.run((a) => a.listTasks()),
    };
  });
  expect(outcome.shared).toBe(true);
  expect(outcome.persistence).toBe("memory");
  expect(outcome.list).toEqual({ ok: true, value: SEED_TASKS });
  expect(outcome.created.ok && outcome.created.value).toMatchObject({
    id: 4,
    title: "O'Brien ☃",
    completed: false,
  });
  expect(outcome.completed.ok && outcome.completed.value.completed).toBe(true);
  expect(outcome.updated.ok && outcome.updated.value).toMatchObject({
    id: 4,
    title: "renamed",
    completed: false,
  });
  expect(outcome.deleted.ok && outcome.deleted.value.title).toBe("renamed");
  expect(outcome.missing).toEqual({
    ok: false,
    tag: "TaskNotFound",
    message: "Task 4 not found",
  });
  expect(outcome.missingComplete).toMatchObject({ tag: "TaskNotFound" });
  expect(outcome.emptyTitle).toEqual({
    ok: false,
    tag: "InvalidInput",
    message: "Invalid input: title is required",
  });
  expect(outcome.badId).toEqual({
    ok: false,
    tag: "InvalidInput",
    message: "Invalid input: id must be an integer",
  });
  expect(outcome.badPatch).toMatchObject({ tag: "InvalidInput" });
  expect(outcome.after).toEqual({ ok: true, value: SEED_TASKS });
  expect(problems).toEqual([]);
});

test("UI re-renders from the changes stream only (external writes on the shared service, workbench SQL box, no polling)", async ({ page }) => {
  const problems = collectProblems(page);
  await open(page, "?d1-persistence=memory");
  const status = page.getByTestId("r1-status");
  await expect(status).toContainText("loads 1");

  // Idle: no timer-driven reloads.
  await page.waitForTimeout(1500);
  expect(await loads(page)).toBe(1);

  // A write that bypasses the application (same service, source "shell").
  await page.evaluate(() =>
    (globalThis as unknown as R1Window).__playground!.r1!.externalWrite(
      "INSERT INTO tasks (title, completed, created_at) VALUES ('written outside the app', 0, '2026-03-01T00:00:00.000Z')",
    )
  );
  await expect(page.getByTestId("r1-task-4")).toContainText(
    "written outside the app",
  );
  await expect(status).toContainText("last change: write from shell (1 row)");
  expect(await loads(page)).toBe(2);

  await page.evaluate(() =>
    (globalThis as unknown as R1Window).__playground!.r1!.externalWrite(
      "UPDATE tasks SET completed = 1 WHERE id = 2; DELETE FROM tasks WHERE id = 3",
    )
  );
  await expect(page.getByTestId("r1-task-3")).toHaveCount(0);
  await expect(page.getByTestId("r1-task-2")).toHaveAttribute(
    "data-completed",
    "true",
  );
  await expect(status).toContainText("write from shell (2 rows)");
  expect(await loads(page)).toBe(3);

  // The workbench panel's SQL box writes to the same database.
  await page.getByTestId("d1-sql").fill(
    "UPDATE tasks SET title = 'edited in the workbench' WHERE id = 1",
  );
  await page.getByTestId("d1-run").click();
  await expect(page.getByTestId("r1-task-1")).toContainText(
    "edited in the workbench",
  );
  await expect(status).toContainText("last change: write from app (1 row)");
  expect(await loads(page)).toBe(4);

  // An unreadable row shows a CorruptTask banner; fixing it with SQL clears
  // the banner on the next good snapshot.
  await page.evaluate(() =>
    (globalThis as unknown as R1Window).__playground!.r1!.externalWrite(
      "UPDATE tasks SET completed = 7 WHERE id = 2",
    )
  );
  await expect(page.getByTestId("r1-error")).toHaveText(
    "Stored data the app cannot read (task 2: row[2]: Expected 0 | 1); fix or delete it with SQL, or reset",
  );
  await page.evaluate(() =>
    (globalThis as unknown as R1Window).__playground!.r1!.externalWrite(
      "UPDATE tasks SET completed = 0 WHERE id = 2",
    )
  );
  await expect(page.getByTestId("r1-error")).toHaveCount(0);
  await expect(page.getByTestId("r1-task-2")).toHaveAttribute(
    "data-completed",
    "false",
  );
  expect(await loads(page)).toBe(5);

  // Reads and failing statements publish nothing, so nothing reloads.
  const failed = await page.evaluate(async () => {
    const r1 = (globalThis as unknown as R1Window).__playground!.r1!;
    await r1.run((a) => a.listTasks());
    await r1.run((a) => a.completeTask(404));
    return await r1.externalWrite("SELECT * FROM missing_table").then(
      () => "succeeded",
      (e: { _tag?: string }) => e._tag,
    );
  });
  expect(failed).toBe("DatabaseError");
  await page.waitForTimeout(500);
  expect(await loads(page)).toBe(5);
  expect(problems).toEqual([]);
});

test("opfs-sahpool: tasks survive a reload; reset restores the seed", async ({ page }) => {
  const problems = collectProblems(page);
  await open(page);
  const status = page.getByTestId("r1-status");
  await expect(status).toContainText("persistence opfs-sahpool");
  await page.getByTestId("r1-title").fill("Survives reload");
  await page.getByTestId("r1-add").click();
  await expect(page.getByTestId("r1-task-4")).toContainText("Survives reload");

  await open(page);
  await expect(status).toContainText("persistence opfs-sahpool");
  await expect(status).toContainText("loads 1");
  await expect(page.getByTestId("r1-task-4")).toContainText("Survives reload");

  await page.getByTestId("r1-reset").click();
  await expect(page.getByTestId("r1-task-4")).toHaveCount(0);
  expect(await titles(page)).toEqual(SEED_TASKS.map((t) => t.title));
  expect(problems).toEqual([]);
});
