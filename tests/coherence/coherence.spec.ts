// Cross-interface coherence in the browser (R4 done-when): on the playground's
// one prototype instance, a task created in the CLI and completed through the
// API is what the UI shows and what a raw SQL query returns; a raw-SQL write
// is visible to the UI, the CLI and the API; `db reset` restores the exact
// seed everywhere; and every interface reports the same failure the same way.
// The editor-console cases run once the shared-engine editor is bound (they
// skip with a note until then).
import { expect, type Page, test } from "@playwright/test";
import {
  apiCall,
  collectProblems,
  d1Events,
  instanceReady,
  r1Loads,
} from "../lifecycle/helpers.ts";

test.describe.configure({ mode: "serial" });

const SEED_TITLES = [
  "Write the project plan",
  "Probe SQLite WASM",
  "Wire the terminal",
];

const terminalText = (page: Page) =>
  page.evaluate(() => {
    const buf = (globalThis as unknown as {
      __playground: {
        term: {
          buffer: {
            active: {
              length: number;
              getLine(
                i: number,
              ): { translateToString(t: boolean): string } | undefined;
            };
          };
        };
      };
    }).__playground.term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buf.length; i++) {
      lines.push(buf.getLine(i)?.translateToString(true) ?? "");
    }
    return lines.join("\n");
  });

async function cli(page: Page, line: string) {
  await page.getByTestId("terminal").locator(".xterm").click();
  await page.keyboard.type(line);
  await page.keyboard.press("Enter");
  await page.evaluate(() =>
    (globalThis as unknown as {
      __playground: { session: { idle(): Promise<void> } };
    })
      .__playground.session.idle()
  );
  return terminalText(page);
}

const uiTitles = (page: Page) =>
  page.getByTestId("r1-tasks").locator("li").evaluateAll((items) =>
    items.map((li) => li.textContent?.trim() ?? "")
  );

const editorHooks = (page: Page) =>
  page.evaluate(() =>
    Boolean(
      (globalThis as unknown as { __playground: { r4: { editor(): unknown } } })
        .__playground.r4.editor(),
    )
  );

test("CLI create -> API complete -> UI and raw SQL agree; one reload and one event per write", async ({ page }) => {
  test.setTimeout(120_000);
  const problems = collectProblems(page);
  await page.goto("/?d1-persistence=memory");
  await instanceReady(page);
  const loads0 = await r1Loads(page);
  const events0 = await d1Events(page);

  const out = await cli(page, 'tasks create "Coherent task"');
  expect(out).toContain("created 4: Coherent task");
  await expect.poll(() => r1Loads(page)).toBe(loads0 + 1);

  const completed = await apiCall(page, "POST", "/tasks/4/complete");
  expect(completed.status).toBe(200);
  await expect.poll(() => r1Loads(page)).toBe(loads0 + 2);
  await expect(page.getByTestId("r1-task-4")).toContainText("Coherent task");
  await expect(page.getByTestId("r1-task-4").locator("input[type=checkbox]"))
    .toBeChecked();

  // Raw SQL through the application terminal (what the console would see).
  const raw = await cli(
    page,
    `db sql --json "SELECT title, completed FROM tasks WHERE id = 4"`,
  );
  expect(raw).toContain('"rows":[["Coherent task",1]]');
  const api = await apiCall(page, "GET", "/tasks/4");
  expect(JSON.parse(api.body).completed).toBe(true);
  expect(await d1Events(page)).toBe(events0 + 2);
  expect(problems).toEqual([]);
});

test("a raw-SQL write is visible in the UI, the CLI and the API with one notification", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/?d1-persistence=memory");
  await instanceReady(page);
  const loads0 = await r1Loads(page);
  const events0 = await d1Events(page);
  await cli(
    page,
    `db sql "INSERT INTO tasks (title, completed, created_at) VALUES ('From raw SQL', 0, '2026-10-08T12:00:00.000Z')"`,
  );
  await expect.poll(() => r1Loads(page)).toBe(loads0 + 1);
  expect(await uiTitles(page)).toContainEqual(
    expect.stringContaining("From raw SQL"),
  );
  await expect(page.getByTestId("r1-status")).toContainText("write from shell");
  const list = await cli(page, "tasks list --json | jq '.[].title'");
  expect(list).toContain('"From raw SQL"');
  const api = await apiCall(page, "GET", "/tasks");
  expect(JSON.parse(api.body).map((t: { title: string }) => t.title)).toContain(
    "From raw SQL",
  );
  expect(await d1Events(page)).toBe(events0 + 1);
});

test("db reset restores the exact seed in the UI, the CLI and the API", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/?d1-persistence=memory");
  await instanceReady(page);
  await cli(page, 'tasks create "temporary"');
  await apiCall(page, "DELETE", "/tasks/1");
  await cli(page, `db sql "CREATE TABLE stray(x)"`);
  const loads0 = await r1Loads(page);
  const out = await cli(page, "db reset");
  const after = out.slice(out.lastIndexOf("$ db reset"));
  expect(after).not.toContain("[exit");
  await expect.poll(() => r1Loads(page)).toBe(loads0 + 1);
  const ui = await uiTitles(page);
  expect(ui.length).toBe(3);
  SEED_TITLES.forEach((t, i) => expect(ui[i]).toContain(t));
  const api = JSON.parse((await apiCall(page, "GET", "/tasks")).body) as {
    id: number;
    title: string;
    completed: boolean;
  }[];
  expect(api.map((t) => [t.id, t.title, t.completed])).toEqual([
    [1, SEED_TITLES[0], true],
    [2, SEED_TITLES[1], false],
    [3, SEED_TITLES[2], false],
  ]);
  const tables = await cli(page, "db tables");
  const tablesOut = tables.slice(tables.lastIndexOf("$ db tables"));
  expect(tablesOut).toContain("tasks");
  expect(tablesOut).not.toContain("stray");
  const next = await apiCall(
    page,
    "POST",
    "/tasks",
    JSON.stringify({ title: "after reset" }),
  );
  expect(JSON.parse(next.body).id).toBe(4);
});

test("every interface reports the same failure the same way and nothing changes", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/?d1-persistence=memory");
  await instanceReady(page);
  const loads0 = await r1Loads(page);
  const events0 = await d1Events(page);

  // Invalid input: CLI stderr + exit 1, API 400, UI banner; nothing published.
  const cliOut = await cli(page, 'tasks create "   "');
  expect(cliOut).toMatch(/tasks: invalid input[^\n]*\n\[exit 1\]/);
  const api = await apiCall(
    page,
    "POST",
    "/tasks",
    JSON.stringify({ title: "   " }),
  );
  expect(api.status).toBe(400);
  expect(JSON.parse(api.body).error.code).toBe("InvalidInput");
  await page.getByTestId("r1-title").fill("   ");
  await page.getByTestId("r1-add").click();
  await expect(page.getByTestId("r1-error")).toContainText("Invalid input");

  // Not found: CLI exit 1, API 404.
  const missing = await cli(page, "tasks complete 404");
  expect(missing).toMatch(/task 404 not found[^\n]*\n\[exit 1\]/);
  expect((await apiCall(page, "POST", "/tasks/404/complete")).status).toBe(404);

  await page.waitForTimeout(500); // a late reload or event would show up here
  expect(await r1Loads(page)).toBe(loads0);
  expect(await d1Events(page)).toBe(events0);
  expect(await uiTitles(page)).toHaveLength(3);
});

test("editor console: app write visible to the shell, shell write visible to the UI/CLI/API, one notification", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/?d1-persistence=memory");
  await instanceReady(page);
  test.skip(
    !(await editorHooks(page)),
    "shared-engine editor not bound: the D1 workbench exposes no engine client yet (claim pending)",
  );
  const loads0 = await r1Loads(page);
  const events0 = await d1Events(page);
  // App write (API) -> shell SELECT shows it.
  await apiCall(
    page,
    "POST",
    "/tasks",
    JSON.stringify({ title: "Seen by the shell" }),
  );
  await expect.poll(() => r1Loads(page)).toBe(loads0 + 1);
  const submit = (line: string) =>
    page.evaluate(
      (l) =>
        (globalThis as unknown as {
          __playground: {
            r4: {
              editor(): { submit(x: string): Promise<void>; screen(): string };
            };
          };
        })
          .__playground.r4.editor().submit(l),
      line,
    );
  const screen = () =>
    page.evaluate(() =>
      (globalThis as unknown as {
        __playground: { r4: { editor(): { screen(): string } } };
      })
        .__playground.r4.editor().screen()
    );
  await submit("SELECT title FROM tasks WHERE id = 4;");
  await expect.poll(screen).toContain("Seen by the shell");
  // Shell write -> UI, CLI and API; exactly one more reload and one event.
  await submit(
    "INSERT INTO tasks (title, completed, created_at) VALUES ('From the console', 0, '2026-10-08T12:30:00.000Z');",
  );
  await expect.poll(() => r1Loads(page)).toBe(loads0 + 2);
  expect(await uiTitles(page)).toContainEqual(
    expect.stringContaining("From the console"),
  );
  expect(await cli(page, "tasks list --json | jq '.[].title'")).toContain(
    '"From the console"',
  );
  expect(
    JSON.parse((await apiCall(page, "GET", "/tasks")).body).map((
      t: { title: string },
    ) => t.title),
  ).toContain("From the console");
  await expect.poll(() => d1Events(page)).toBe(events0 + 2);
});
