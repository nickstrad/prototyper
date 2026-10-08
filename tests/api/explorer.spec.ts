// R3 browser suite: the API explorer in the playground. Requests are built
// by the form and handed straight to the in-page ApiHandler; the tests prove
// no network transport is involved (no window.fetch call, no browser request
// to the API origin or to an API-shaped path) and that the handler runs on
// the page's one DatabaseService, so tasks created or changed through the
// explorer show up in R1's task manager panel through the changes stream.
import { expect, type Page, test } from "@playwright/test";
import process from "node:process";
import type { TaskManagerHooks } from "../../prototypes/task-manager/App.tsx";
import type { ApiExplorerHooks } from "../../playground/api/ApiExplorer.tsx";
import { SEED_TASKS } from "../../prototypes/task-manager/seed.ts";

const out = process.env.PW_OUT ?? "test-results";
const target = process.env.PW_TARGET ?? "dev";
const API_ORIGIN = "https://api.invalid";

type PlaygroundWindow = {
  __playground?: {
    r1?: TaskManagerHooks;
    r3?: ApiExplorerHooks;
    d1?: { service: unknown };
  };
  __fetchCalls?: string[];
};

// OO1 logs every failing sqlite3_step() to the worker console; the CorruptTask
// case below makes the engine reject nothing, but D1's page logs these lines.
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

/** Browser requests that look like API traffic (none must exist). */
function watchNetwork(page: Page) {
  const apiLike: string[] = [];
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (
      r.url().startsWith(API_ORIGIN) ||
      /^\/(tasks(\/|$)|reset$|sql$|api\/)/.test(u.pathname)
    ) apiLike.push(`${r.method()} ${r.url()}`);
  });
  return apiLike;
}

async function open(page: Page) {
  // Record every window.fetch call so "no transport" is observable.
  await page.addInitScript(() => {
    const w = globalThis as unknown as PlaygroundWindow;
    w.__fetchCalls = [];
    const real = globalThis.fetch.bind(globalThis);
    globalThis.fetch = (input, init) => {
      w.__fetchCalls!.push(
        typeof input === "string"
          ? input
          : input instanceof URL
          ? input.href
          : (input as Request).url,
      );
      return real(input, init);
    };
  });
  await page.goto("/?d1-persistence=memory");
  await page.waitForFunction(
    () => {
      const pg = (globalThis as unknown as PlaygroundWindow).__playground;
      return pg?.r1 !== undefined && pg?.r3 !== undefined;
    },
    undefined,
    { timeout: 45_000 },
  );
  // Page start-up (wasm, workers) may fetch; only interaction is judged.
  await page.evaluate(() => {
    (globalThis as unknown as PlaygroundWindow).__fetchCalls!.length = 0;
  });
}

const fetchCalls = (page: Page) =>
  page.evaluate(() =>
    (globalThis as unknown as PlaygroundWindow).__fetchCalls!.slice()
  );

/** Handler calls so far, as the status line reports them. */
const callCount = async (page: Page) =>
  Number(
    (await page.getByTestId("r3-status").innerText()).match(
      /handler calls (\d+)/,
    )?.[1],
  );

/** Fills the form and sends; resolves when the response is on screen. */
async function send(page: Page, method: string, path: string, body = "") {
  const before = await callCount(page);
  await page.getByTestId("r3-method").selectOption(method);
  await page.getByTestId("r3-path").fill(path);
  await page.getByTestId("r3-body").fill(body);
  await page.getByTestId("r3-send").click();
  await expect(page.getByTestId("r3-status")).toContainText(
    `handler calls ${before + 1} `,
  );
  return {
    status: Number(
      (await page.getByTestId("r3-response-status").innerText()).split(" ")[0],
    ),
    headers: await page.getByTestId("r3-response-headers").innerText(),
    text: await page.getByTestId("r3-response-body").innerText(),
  };
}

const r1Titles = (page: Page) =>
  page.getByTestId("r1-tasks").getByTestId("r1-task-title").allTextContents();

const r1Loads = (page: Page) =>
  page.evaluate(() =>
    (globalThis as unknown as PlaygroundWindow).__playground!.r1!.loads()
  );

test("GET, POST, PATCH, DELETE from the form: in-process, no network", async ({ page }) => {
  const problems = collectProblems(page);
  const network = watchNetwork(page);
  await open(page);
  await expect(page.getByTestId("r3-status")).toContainText(
    "SQLite 3.54.0",
  );
  await expect(page.getByTestId("r3-status")).toContainText(
    "transport: none",
  );

  const list = await send(page, "GET", "/tasks");
  expect(list.status).toBe(200);
  expect(list.headers).toContain("content-type: application/json");
  expect(JSON.parse(list.text)).toEqual(SEED_TASKS);

  const created = await send(
    page,
    "POST",
    "/tasks",
    '{ "title": "  Created by the explorer  " }',
  );
  expect(created.status).toBe(201);
  expect(created.headers).toContain("location: /tasks/4");
  expect(JSON.parse(created.text)).toMatchObject({
    id: 4,
    title: "Created by the explorer",
    completed: false,
  });

  const patched = await send(
    page,
    "PATCH",
    "/tasks/4",
    '{ "completed": true }',
  );
  expect(patched.status).toBe(200);
  expect(JSON.parse(patched.text)).toMatchObject({ id: 4, completed: true });

  const got = await send(page, "GET", "/tasks/4");
  expect(JSON.parse(got.text)).toMatchObject({ id: 4, completed: true });

  const deleted = await send(page, "DELETE", "/tasks/4");
  expect(deleted.status).toBe(200);
  expect(JSON.parse(deleted.text)).toMatchObject({ id: 4 });
  expect((await send(page, "GET", "/tasks/4")).status).toBe(404);

  // Every call went through the in-page handler, against the API origin that
  // never resolves, and nothing used fetch or hit the network.
  const calls = await page.evaluate(() =>
    (globalThis as unknown as PlaygroundWindow).__playground!.r3!.calls()
  );
  expect(calls.map((c) => `${c.method} ${c.path} ${c.status}`)).toEqual([
    "GET /tasks 200",
    "POST /tasks 201",
    "PATCH /tasks/4 200",
    "GET /tasks/4 200",
    "DELETE /tasks/4 200",
    "GET /tasks/4 404",
  ]);
  expect(calls.every((c) => c.url.startsWith(`${API_ORIGIN}/`))).toBe(true);
  expect(await fetchCalls(page)).toEqual([]);
  expect(network).toEqual([]);
  expect(problems).toEqual([]);
});

test("a task created in the explorer appears in R1's UI via the change stream", async ({ page }) => {
  const problems = collectProblems(page);
  const network = watchNetwork(page);
  await open(page);
  const status = page.getByTestId("r1-status");
  await expect(status).toContainText("loads 1");
  expect(await r1Titles(page)).toEqual(SEED_TASKS.map((t) => t.title));

  // Preset "Create task" fills POST /tasks; Send creates it.
  await page.getByRole("button", { name: "Create task", exact: true }).click();
  await page.getByTestId("r3-send").click();
  await expect(page.getByTestId("r1-task-4")).toContainText(
    "Created from the API explorer",
  );
  await expect(status).toContainText("loads 2");
  await expect(status).toContainText("last change: write from app (1 row)");

  // Complete, rename, delete through the explorer; the panel follows.
  await send(page, "POST", "/tasks/2/complete");
  await expect(page.getByTestId("r1-task-2")).toHaveAttribute(
    "data-completed",
    "true",
  );
  await send(
    page,
    "PATCH",
    "/tasks/3",
    '{ "title": "Renamed over HTTP-shaped API" }',
  );
  await expect(page.getByTestId("r1-task-3")).toContainText(
    "Renamed over HTTP-shaped API",
  );
  await send(page, "DELETE", "/tasks/1");
  await expect(page.getByTestId("r1-task-1")).toHaveCount(0);

  // A failed call writes nothing and reloads nothing.
  const loadsBefore = await r1Loads(page);
  expect((await send(page, "DELETE", "/tasks/1")).status).toBe(404);
  await page.waitForTimeout(300);
  expect(await r1Loads(page)).toBe(loadsBefore);

  // Reset through the explorer restores the seed in the panel.
  await send(page, "POST", "/reset");
  await expect(status).toContainText("last change: reset by host");
  expect(await r1Titles(page)).toEqual(SEED_TASKS.map((t) => t.title));
  expect(network).toEqual([]);
  expect(problems).toEqual([]);
});

test("a task created in R1's UI is served by the explorer (one shared service)", async ({ page }) => {
  const problems = collectProblems(page);
  await open(page);
  await expect(page.getByTestId("r1-status")).toContainText("loads 1");
  await page.getByTestId("r1-title").fill("Typed into the task manager");
  await page.getByTestId("r1-add").click();
  await expect(page.getByTestId("r1-task-4")).toBeVisible();

  const got = await send(page, "GET", "/tasks/4");
  expect(got.status).toBe(200);
  expect(JSON.parse(got.text)).toMatchObject({
    id: 4,
    title: "Typed into the task manager",
  });
  const same = await page.evaluate(() => {
    const pg = (globalThis as unknown as PlaygroundWindow).__playground!;
    return {
      r1: pg.r1!.service === pg.d1!.service,
      r3: pg.r3!.service === pg.d1!.service,
    };
  });
  expect(same).toEqual({ r1: true, r3: true });
  expect(problems).toEqual([]);
});

test("400, 404, 405 and 500 are shown with their JSON error bodies", async ({ page }) => {
  const problems = collectProblems(page);
  await open(page);

  const blank = await send(page, "POST", "/tasks", '{ "title": "   " }');
  expect(blank.status).toBe(400);
  expect(JSON.parse(blank.text)).toEqual({
    error: {
      code: "InvalidInput",
      message: "Invalid input: title is required",
    },
  });
  const badJson = await send(page, "POST", "/tasks", "{ not json");
  expect(badJson.status).toBe(400);
  expect(JSON.parse(badJson.text).error.code).toBe("InvalidJson");
  const badId = await send(page, "GET", "/tasks/abc");
  expect([badId.status, JSON.parse(badId.text).error.code]).toEqual([
    400,
    "InvalidInput",
  ]);

  const missing = await send(page, "GET", "/tasks/999");
  expect(missing.status).toBe(404);
  expect(JSON.parse(missing.text)).toEqual({
    error: { code: "TaskNotFound", message: "Task 999 not found" },
  });
  const route = await send(page, "GET", "/nope");
  expect([route.status, JSON.parse(route.text).error.code]).toEqual([
    404,
    "RouteNotFound",
  ]);
  // The method select offers only the four verbs; 405 comes from the hook.
  const put = await page.evaluate(() =>
    (globalThis as unknown as PlaygroundWindow).__playground!.r3!.call(
      "PUT",
      "/tasks/1",
      "{}",
    )
  );
  expect(put.status).toBe(405);

  // A row written outside the application that it cannot read: 500.
  await page.evaluate(() =>
    (globalThis as unknown as PlaygroundWindow).__playground!.r1!.externalWrite(
      "UPDATE tasks SET completed = 7 WHERE id = 2",
    )
  );
  const corrupt = await send(page, "GET", "/tasks");
  expect(corrupt.status).toBe(500);
  expect(JSON.parse(corrupt.text).error.code).toBe("CorruptTask");
  expect(JSON.parse(corrupt.text).error.message).toContain("task 2");
  // Reset repairs it.
  expect((await send(page, "POST", "/reset")).status).toBe(200);
  expect((await send(page, "GET", "/tasks")).status).toBe(200);
  expect(problems).toEqual([]);
});

test("SQL preset shows bigint and blob cells in their tagged JSON form", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "SQL with bigint and blob" }).click();
  await page.getByTestId("r3-send").click();
  const body = page.getByTestId("r3-response-body");
  await expect(body).toContainText('"$type": "bigint"');
  await expect(body).toContainText('"value": "9007199254740993"');
  await expect(body).toContainText('"$type": "blob"');
  await expect(body).toContainText('"base64": "AP8="');
});

test("SQL writes carry source host; calls and history stay bounded", async ({ page }) => {
  const problems = collectProblems(page);
  await open(page);
  const status = page.getByTestId("r1-status");
  await expect(status).toContainText("loads 1");
  const inserted = await send(
    page,
    "POST",
    "/sql",
    JSON.stringify({
      sql:
        "INSERT INTO tasks (title, completed, created_at) VALUES ('raw sql row', 0, '2026-03-01T00:00:00.000Z')",
    }),
  );
  expect(inserted.status).toBe(200);
  await expect(page.getByTestId("r1-task-4")).toContainText("raw sql row");
  // Raw SQL is not an application write (R1's panel labels the source).
  await expect(status).toContainText("last change: write from host (1 row)");
  // A script is refused before anything runs.
  const script = await send(
    page,
    "POST",
    "/sql",
    JSON.stringify({ sql: "DELETE FROM tasks; DELETE FROM tasks" }),
  );
  expect(script.status).toBe(400);
  expect(JSON.parse(script.text).error.message).toContain("single statement");
  await expect(page.getByTestId("r1-task-4")).toBeVisible();

  // Twelve more calls: the hook and the visible history keep the last ten.
  for (let i = 0; i < 12; i++) await send(page, "GET", "/tasks");
  const kept = await page.evaluate(() =>
    (globalThis as unknown as PlaygroundWindow).__playground!.r3!.calls().length
  );
  expect(kept).toBe(10);
  await expect(page.getByTestId("r3-history").locator("li")).toHaveCount(10);
  await expect(page.getByTestId("r3-status")).toContainText(
    "handler calls 14 ",
  );
  expect(problems).toEqual([]);
});

test("explorer layout: no clipping or overlap", async ({ page }) => {
  await open(page);
  await send(page, "POST", "/tasks", '{ "title": "Layout check" }');
  await send(page, "GET", "/tasks");
  const panel = page.getByTestId("r3-api-explorer");
  await panel.scrollIntoViewIfNeeded();
  await panel.screenshot({ path: `${out}/r3-explorer-panel-${target}.png` });
  await page.screenshot({
    path: `${out}/r3-explorer-${target}.png`,
    fullPage: true,
  });
  const box = await panel.boundingBox();
  expect(box!.width).toBeGreaterThan(300);
  // Nothing inside the panel is wider than the panel itself.
  const overflow = await panel.evaluate((el) =>
    [...el.querySelectorAll("*")].filter((c) => {
      const r = c.getBoundingClientRect();
      const p = el.getBoundingClientRect();
      return r.width > 0 && (r.right > p.right + 1 || r.left < p.left - 1);
    }).map((c) => c.tagName)
  );
  expect(overflow).toEqual([]);
});
