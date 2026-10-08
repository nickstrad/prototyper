// R2 browser suite: the playground's application terminal (xterm.js +
// just-bash) runs the real `tasks` and `db` commands on the same
// DatabaseService as the R1 task manager panel (D1's workbench engine). Every
// terminal write must appear in the R1 UI through the `changes` stream (one
// reload per write, none for reads or failures); typed failures render as red
// stderr + `[exit 1]`; `tasks list --json | jq` renders; `db reset` restores
// exactly the seed in both the terminal and the UI.
import { expect, type Page, test } from "@playwright/test";
import process from "node:process";
import type { TaskManagerHooks } from "../../prototypes/task-manager/App.tsx";
import { SEED_TASKS } from "../../prototypes/task-manager/seed.ts";

const out = process.env.PW_OUT ?? "test-results";
const target = process.env.PW_TARGET ?? "dev";

type R2Window = {
  __playground?: {
    r1?: TaskManagerHooks;
    d1?: { service: unknown };
    term: {
      buffer: {
        active: {
          length: number;
          getLine(i: number):
            | {
              isWrapped: boolean;
              translateToString(trim: boolean): string;
              getCell(x: number): { getFgColor(): number } | undefined;
            }
            | undefined;
        };
      };
    };
    session: { idle(): Promise<void> };
  };
};

// OO1 logs every failing sqlite3_step() to the worker console; the failing
// SQL below is deliberate.
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

async function open(page: Page, query = "?d1-persistence=memory") {
  await page.goto(`/${query}`);
  await page.waitForFunction(
    () => (globalThis as unknown as R2Window).__playground?.r1 !== undefined,
    undefined,
    { timeout: 45_000 },
  );
  await expect(page.getByTestId("r1-status")).toContainText("loads 1");
  await page.getByTestId("terminal").locator(".xterm").click();
}

/** Terminal lines (scrollback included, soft-wrapped rows joined), plain text. */
const lines = (page: Page) =>
  page.evaluate(() => {
    const buf = (globalThis as unknown as R2Window).__playground!.term.buffer
      .active;
    const all: string[] = [];
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      const text = line?.translateToString(true) ?? "";
      if (line?.isWrapped && all.length > 0) all[all.length - 1] += text;
      else all.push(text);
    }
    return all.map((l) => l.trimEnd());
  });

/**
 * Runs `cmd` and returns what it printed: the lines between its `$ cmd`
 * prompt line and the fresh `$` prompt that follows, which must be the last
 * prompt in the buffer (so the output belongs to this command). Clicks the
 * terminal first: UI steps in between move the keyboard focus.
 */
async function run(page: Page, cmd: string): Promise<string> {
  await page.getByTestId("terminal").locator(".xterm").click();
  await page.keyboard.type(cmd);
  await page.keyboard.press("Enter");
  await page.evaluate(() =>
    (globalThis as unknown as R2Window).__playground!.session.idle()
  );
  const all = await lines(page);
  const end = all.lastIndexOf("$");
  const start = all.lastIndexOf(`$ ${cmd}`, end);
  expect(start, `prompt line for ${cmd}`).toBeGreaterThanOrEqual(0);
  const output = all.slice(start + 1, end);
  expect(output.filter((l) => l.startsWith("$ ")), "one command").toEqual([]);
  // xterm renders a tab as spaces up to the next tab stop.
  return output.join("\n").replace(/ {2,}/g, "\t");
}

/** Whether the first character of the line containing `text` is red (ANSI 1). */
const isRed = (page: Page, text: string) =>
  page.evaluate((text) => {
    const buf = (globalThis as unknown as R2Window).__playground!.term.buffer
      .active;
    for (let i = buf.length - 1; i >= 0; i--) {
      const line = buf.getLine(i);
      if (line?.translateToString(true).startsWith(text)) {
        return line.getCell(0)?.getFgColor() === 1;
      }
    }
    return null;
  }, text);

const loads = (page: Page) =>
  page.evaluate(() =>
    (globalThis as unknown as R2Window).__playground!.r1!.loads()
  );

const uiTitles = (page: Page) =>
  page.getByTestId("r1-tasks").getByTestId("r1-task-title").allTextContents();

test("terminal creates, completes, updates and deletes tasks the R1 UI shows", async ({ page }) => {
  const problems = collectProblems(page);
  await open(page);
  const status = page.getByTestId("r1-status");

  expect(await run(page, 'tasks create "Build the CLI"')).toBe(
    "created 4: Build the CLI",
  );
  await expect(page.getByTestId("r1-task-4")).toContainText("Build the CLI");
  await expect(page.getByTestId("r1-task-4")).toHaveAttribute(
    "data-completed",
    "false",
  );
  await expect(status).toContainText("last change: write from app (1 row)");
  await expect.poll(() => loads(page)).toBe(2);

  expect(await run(page, "tasks complete 4")).toBe(
    "completed 4: Build the CLI",
  );
  await expect(page.getByTestId("r1-task-4")).toHaveAttribute(
    "data-completed",
    "true",
  );
  await expect.poll(() => loads(page)).toBe(3);

  expect(await run(page, "tasks update 3 --title 'Wire the CLI'")).toBe(
    "updated 3: Wire the CLI",
  );
  await expect(page.getByTestId("r1-task-3")).toContainText("Wire the CLI");

  expect(await run(page, "tasks delete 2")).toBe(
    "deleted 2: Probe SQLite WASM",
  );
  await expect(page.getByTestId("r1-task-2")).toHaveCount(0);
  await expect.poll(() => loads(page)).toBe(5);
  expect(await uiTitles(page)).toEqual([
    "Write the project plan",
    "Wire the CLI",
    "Build the CLI",
  ]);

  // A write made in the UI is what the terminal reads (one database).
  await page.getByTestId("r1-title").fill("Made in the UI");
  await page.getByTestId("r1-add").click();
  await expect(page.getByTestId("r1-task-5")).toContainText("Made in the UI");
  expect(await run(page, "tasks get 5")).toBe("5\t[ ] Made in the UI");

  // jq pipeline over the shared data renders in the terminal.
  expect(await run(page, "tasks list --json | jq '.[].title'")).toBe(
    '"Write the project plan"\n"Wire the CLI"\n"Build the CLI"\n"Made in the UI"',
  );
  expect(
    await run(
      page,
      "tasks list --json | jq -r '.[] | select(.completed) | .id'",
    ),
  ).toBe("1\n4");
  // Reads never reload the UI.
  await page.waitForTimeout(300);
  expect(await loads(page)).toBe(6);

  await page.screenshot({
    path: `${out}/r2-terminal-${target}.png`,
    fullPage: true,
  });
  expect(problems).toEqual([]);
});

test("invalid input and a missing task: red stderr, nonzero exit, nothing written", async ({ page }) => {
  const problems = collectProblems(page);
  await open(page);

  expect(await run(page, 'tasks create ""')).toBe(
    "tasks: invalid input: title is required\n[exit 1]",
  );
  expect(await isRed(page, "tasks: invalid input: title is required")).toBe(
    true,
  );
  expect(await run(page, "tasks complete 42")).toBe(
    "tasks: task 42 not found\n[exit 1]",
  );
  expect(await isRed(page, "tasks: task 42 not found")).toBe(true);
  expect(await run(page, "tasks delete abc")).toBe(
    'tasks: invalid input: id must be an integer, got "abc"\n[exit 1]',
  );
  expect(await run(page, "tasks get 0")).toBe(
    "tasks: invalid input: id must be positive\n[exit 1]",
  );
  // R0's adapter prints a line's stdout, then its stderr.
  expect(await run(page, "tasks complete 42 || echo recovered")).toBe(
    "recovered\ntasks: task 42 not found",
  );
  expect(await run(page, "tasks complete 42 2>/dev/null; echo $?")).toBe("1");
  expect(await run(page, "db sql 'SELECT * FROM nope'")).toMatch(
    /^db: database error \(execute\): .*no such table: nope\n\[exit 1\]$/,
  );
  const usage = await run(page, "tasks frobnicate");
  expect(usage).toMatch(/^usage: tasks <command>\n/);
  expect(usage).toMatch(/\n\[exit 2\]$/);
  // Success prints no exit marker.
  expect(await run(page, "tasks get 1")).toBe("1\t[x] Write the project plan");

  await page.waitForTimeout(300);
  expect(await loads(page), "failures publish no change").toBe(1);
  expect(await uiTitles(page)).toEqual(SEED_TASKS.map((t) => t.title));
  expect(problems).toEqual([]);
});

test("db tables/schema/sql on the shared service; db reset restores the seed in terminal and UI", async ({ page }) => {
  const problems = collectProblems(page);
  await open(page);
  const status = page.getByTestId("r1-status");

  expect(await run(page, "db tables")).toBe("tasks");
  expect(await run(page, "db schema tasks")).toContain("CREATE TABLE tasks (");
  expect(await run(page, "db info")).toMatch(
    /^sqlite 3\.54\.0 · persistence memory/,
  );
  // Raw SQL from the terminal: the UI re-renders from the change stream.
  expect(
    await run(
      page,
      `db sql "INSERT INTO tasks (title, completed, created_at) VALUES ('from db sql', 0, '2026-05-01T00:00:00.000Z')"`,
    ),
  ).toBe("changes: 1");
  await expect(page.getByTestId("r1-task-4")).toContainText("from db sql");
  await expect(status).toContainText("last change: write from shell (1 row)");
  expect(
    await run(
      page,
      `db sql --json "SELECT 9007199254740993 AS big, x'00ff' AS b" | jq -c '.rows[0]'`,
    ),
  ).toBe(
    '[{"$type":"bigint","value":"9007199254740993"},{"$type":"blob","base64":"AP8="}]',
  );

  // Scramble: terminal and UI edits, an extra table, then reset.
  await run(page, "tasks create Extra");
  await run(page, "tasks delete 1");
  await run(page, "tasks complete 2");
  await run(page, "db sql 'CREATE TABLE junk (x)'");
  await page.getByTestId("r1-task-3").getByRole("button", {
    name: "Delete task 3",
  }).click();
  await expect(page.getByTestId("r1-task-3")).toHaveCount(0);
  expect(await uiTitles(page)).not.toEqual(SEED_TASKS.map((t) => t.title));

  expect(await run(page, "db reset")).toBe("database reset to its seed data");
  await expect(status).toContainText("last change: reset by");
  await expect.poll(() => uiTitles(page)).toEqual(
    SEED_TASKS.map((t) => t.title),
  );
  await expect(page.getByTestId("r1-task-1")).toHaveAttribute(
    "data-completed",
    "true",
  );
  await expect(page.getByTestId("r1-task-2")).toHaveAttribute(
    "data-completed",
    "false",
  );
  expect(JSON.parse(await run(page, "tasks list --json"))).toEqual(SEED_TASKS);
  expect(await run(page, "db tables")).toBe("tasks");
  const viaApp = await page.evaluate(() =>
    (globalThis as unknown as R2Window).__playground!.r1!.run((a) =>
      a.listTasks()
    )
  );
  expect(viaApp).toEqual({ ok: true, value: SEED_TASKS });
  expect(await run(page, "tasks create Again")).toBe("created 4: Again");
  await expect(page.getByTestId("r1-task-4")).toContainText("Again");
  expect(problems).toEqual([]);
});

test("default page (opfs-sahpool workbench): terminal and UI share the persistent database", async ({ page }) => {
  const problems = collectProblems(page);
  await open(page, "");
  expect(await run(page, "db info")).toMatch(/persistence opfs-sahpool/);
  expect(await run(page, "tasks create Persisted")).toBe(
    "created 4: Persisted",
  );
  await expect(page.getByTestId("r1-task-4")).toContainText("Persisted");
  await page.reload();
  await open(page, "");
  await expect(page.getByTestId("r1-task-4")).toContainText("Persisted");
  expect(await run(page, "tasks get 4")).toBe("4\t[ ] Persisted");
  expect(await run(page, "db reset")).toBe("database reset to its seed data");
  await expect.poll(() => uiTitles(page)).toEqual(
    SEED_TASKS.map((t) => t.title),
  );
  expect(problems).toEqual([]);
});
