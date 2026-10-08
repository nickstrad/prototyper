// DB1 lifecycle (plan.md Q18): the upstream DuckDB shell is embedded once per
// prototype instance; hiding and showing the database view moves its element
// instead of re-embedding; disposing the instance disposes the shell's
// terminal (its window/document listeners go with it) and terminates the
// engine worker (`db.terminate()`). Listener lists come from DevTools
// (DOMDebugger.getEventListeners), workers from page.workers().
import { expect, type Page, test } from "@playwright/test";
import {
  collectProblems,
  db1,
  duckDbWorkers,
  focusShell,
  jsListenerCount,
  liveListeners,
  loadPlayground,
  loadPlaygroundHooks,
  openDuckDb,
  openInstance,
  outputOf,
  saveEvidence,
  screen,
  screenshot,
  settledListeners,
  target,
  trackScripts,
  typeLine,
} from "./helpers.ts";

test.describe.configure({ timeout: 240_000 });

const host = (page: Page) => page.getByTestId("db1-workbench");

test("six hide/show cycles move the one embedded shell and leak nothing", async ({ page }) => {
  const problems = collectProblems(page);
  const cdp = await page.context().newCDPSession(page);
  const shellListeners = await trackScripts(cdp);
  await openDuckDb(page);
  await typeLine(page, ".timer on");
  await typeLine(page, "SELECT 'before cycles' AS mark;");
  await db1(page, (h) => {
    (h.runtime!.binding.element as unknown as { __db1Mark: number })
      .__db1Mark = 1;
  }, null);
  const embeds = await db1(page, (h) => h.runtime!.binding.embeds, null);
  expect(embeds).toBe(1);
  const workers = duckDbWorkers(page);
  expect(workers).toBe(1);

  const hideShow = async () => {
    await page.getByTestId("db1-toggle").click(); // hide: host unmounts
    await expect(host(page).getByTestId("db-editor")).toHaveCount(0);
    expect(
      await db1(page, (h) => h.runtime!.binding.element.isConnected, null),
    ).toBe(false);
    await page.getByTestId("db1-toggle").click(); // show: host mounts again
    await expect(page.getByTestId("duckdb-shell").locator(".xterm"))
      .toBeVisible();
    const state = await db1(page, (h) => {
      const b = h.runtime!.binding;
      return {
        embeds: b.embeds,
        same: (b.element as unknown as { __db1Mark?: number }).__db1Mark === 1,
        inHost: b.element.parentElement?.dataset.testid === "db-console",
      };
    }, null);
    expect(state).toEqual({ embeds: 1, same: true, inHost: true });
    expect(duckDbWorkers(page)).toBe(workers);
    expect(await shellListeners()).toEqual(["window:resize", "window:resize"]);
  };

  const log: string[] = [
    `before warm-up: duckdbWorkers=${workers} jsListeners=${await jsListenerCount(
      cdp,
    )} ${JSON.stringify(await liveListeners(cdp))}`,
  ];
  // One warm-up cycle: the host's first remount settles React and xterm
  // state once (a fixed +5 JS listeners in dev, none on window/document).
  await hideShow();
  const listeners = await settledListeners(cdp, page);
  const jsBefore = await jsListenerCount(cdp);
  log.push(
    `baseline after warm-up: jsListeners=${jsBefore} ${
      JSON.stringify(listeners)
    }`,
  );
  for (let cycle = 1; cycle <= 6; cycle++) {
    await hideShow();
    const now = await liveListeners(cdp);
    const js = await jsListenerCount(cdp);
    log.push(
      `cycle ${cycle}: duckdbWorkers=${duckDbWorkers(page)} jsListeners=${js} ${
        JSON.stringify(now)
      }`,
    );
    saveEvidence(`06-hide-show-${target}.txt`, log.join("\n") + "\n");
    expect(now).toEqual(listeners);
    expect(js).toBe(jsBefore);
  }
  expect(
    await db1(page, (h) => h.runtime!.binding.mounts, null),
  ).toBeGreaterThanOrEqual(8);

  // The session survived: scrollback, `.timer on`, the shell's connection.
  await focusShell(page);
  expect(await screen(page)).toContain("before cycles");
  await typeLine(page, "SELECT 'after cycles' AS mark;");
  expect(outputOf(await screen(page), "SELECT 'after cycles' AS mark;"))
    .toMatch(/after cycles[\s\S]*Elapsed: \d+ ms/);
  saveEvidence(`06-hide-show-${target}.txt`, log.join("\n") + "\n");
  await screenshot(page, "06-after-cycles");
  // Narrow viewport: the host panel wraps under the console (visual check).
  // Tall enough for the whole section: a capture beyond the viewport resizes
  // the page, and the shell's resize handler then redraws from the top.
  await page.setViewportSize({ width: 900, height: 1200 });
  await screenshot(page, "06-narrow");
  expect(problems).toEqual([]);
});

test("six dispose/reopen cycles terminate the worker and leak no listeners", async ({ page }) => {
  const problems = collectProblems(page);
  const cdp = await page.context().newCDPSession(page);
  const started: string[] = [];
  const closed: string[] = [];
  page.on("worker", (w) => {
    if (!w.url().includes("duckdb")) return; // the playground's Fiddle workers
    started.push(w.url());
    w.on("close", () => closed.push(w.url()));
  });
  const shellListeners = await trackScripts(cdp);
  await loadPlayground(page);
  const pristine = await settledListeners(cdp, page);
  const log = [`pristine (nothing DuckDB loaded): ${JSON.stringify(pristine)}`];

  const cycle = async () => {
    await openInstance(page);
    await focusShell(page);
    // The shell's xterm (RenderService, BufferDecorationRenderer).
    const whileOpen = await shellListeners();
    log.push(`open: shell listeners ${JSON.stringify(whileOpen)}`);
    expect(whileOpen).toEqual(["window:resize", "window:resize"]);
    await typeLine(page, "SELECT count(*) AS n FROM tasks;");
    expect(outputOf(await screen(page), "SELECT count(*) AS n FROM tasks;"))
      .toMatch(/│\s+3 │/);
    expect(duckDbWorkers(page)).toBe(1);
    const result = await db1(page, async (h) => {
      const runtime = h.runtime!;
      await h.dispose();
      return {
        detached: runtime.handle.db.isDetached(),
        disposeErrors: [...runtime.binding.disposeErrors],
        reportErrors: [...runtime.binding.reportErrors],
        connected: runtime.binding.element.isConnected,
      };
    }, null);
    // db.terminate() ran: no worker left behind the instance.
    expect(result).toEqual({
      detached: true,
      disposeErrors: [],
      reportErrors: [],
      connected: false,
    });
    await expect(page.getByTestId("db1-status")).toContainText(
      "instance disposed",
    );
    await expect.poll(() => duckDbWorkers(page)).toBe(0);
    expect(await shellListeners()).toEqual([]);
  };

  // Warm-up: the first instance also loads the modules.
  await cycle();
  const baseline = await liveListeners(cdp);
  const jsBaseline = await jsListenerCount(cdp);
  log.push(
    `after warm-up instance: duckdbWorkers=${
      duckDbWorkers(page)
    } jsListeners=${jsBaseline} ${JSON.stringify(baseline)}`,
  );

  for (let k = 1; k <= 6; k++) {
    await cycle();
    const now = await liveListeners(cdp);
    const js = await jsListenerCount(cdp);
    log.push(
      `after dispose ${k}: duckdbWorkers=${
        duckDbWorkers(page)
      } jsListeners=${js} ${JSON.stringify(now)} shell listeners ${
        JSON.stringify(await shellListeners())
      }`,
    );
    saveEvidence(`07-dispose-cycles-${target}.txt`, log.join("\n") + "\n");
    expect(now).toEqual(baseline);
    expect(js).toBe(jsBaseline);
  }
  await expect.poll(() => closed.length).toBe(7);
  expect(started.length).toBe(7);
  log.push(`duckdb workers started=${started.length} closed=${closed.length}`);
  saveEvidence(`07-dispose-cycles-${target}.txt`, log.join("\n") + "\n");
  expect(problems).toEqual([]);
});

type LifecycleWindow = {
  __playgroundLifecycle?: { generation(): number; isOpen(): boolean };
  __playground?: { db1?: unknown };
  __db1Previous?: {
    handle: { db: { isDetached(): boolean } };
    binding: {
      element: HTMLElement;
      disposeErrors: readonly string[];
      reportErrors: readonly string[];
    };
  };
};

test("closing the playground instance disposes the shell; the reopened instance rebinds it", async ({ page }) => {
  const problems = collectProblems(page);
  const cdp = await page.context().newCDPSession(page);
  const started: string[] = [];
  const closed: string[] = [];
  page.on("worker", (w) => {
    if (!w.url().includes("duckdb")) return;
    started.push(w.url());
    w.on("close", () => closed.push(w.url()));
  });
  const shellListeners = await trackScripts(cdp);
  const generation = () =>
    page.evaluate(() =>
      (globalThis as LifecycleWindow).__playgroundLifecycle!.generation()
    );
  const log: string[] = [];

  await openDuckDb(page);
  const first = await generation();
  await typeLine(page, "CREATE TABLE first_instance AS SELECT 1 AS x;");
  expect(await db1(page, (h) => h.tables(), null)).toContain("first_instance");
  // Keep the first instance's runtime to inspect it after the close.
  await db1(page, (h) => {
    (globalThis as LifecycleWindow).__db1Previous = h.runtime as never;
  }, null);
  log.push(
    `generation ${first} open: duckdbWorkers=${
      duckDbWorkers(page)
    } shell listeners ${JSON.stringify(await shellListeners())}`,
  );

  // Close: the whole instance (and the DB1 workbench with it) unmounts.
  await page.getByTestId("instance-close").click();
  await expect(page.getByTestId("db1-workbench")).toHaveCount(0);
  await expect.poll(() => duckDbWorkers(page)).toBe(0);
  const previous = await page.evaluate(() => {
    const p = (globalThis as LifecycleWindow).__db1Previous!;
    return {
      detached: p.handle.db.isDetached(),
      connected: p.binding.element.isConnected,
      disposeErrors: [...p.binding.disposeErrors],
      reportErrors: [...p.binding.reportErrors],
      hooks: Boolean((globalThis as LifecycleWindow).__playground),
    };
  });
  expect(previous).toEqual({
    detached: true,
    connected: false,
    disposeErrors: [],
    reportErrors: [],
    hooks: false,
  });
  expect(await shellListeners()).toEqual([]);
  log.push(
    `closed: duckdbWorkers=${duckDbWorkers(page)} first instance ${
      JSON.stringify(previous)
    } shell listeners ${JSON.stringify(await shellListeners())}`,
  );

  // Reopen: a new generation, new hooks; nothing DuckDB until "Open".
  await page.getByTestId("instance-reopen").click();
  await loadPlaygroundHooks(page);
  const second = await generation();
  expect(second).toBe(first + 1);
  await expect(page.getByTestId("db1-status")).toHaveText("DuckDB not loaded");
  expect(duckDbWorkers(page)).toBe(0);
  await openInstance(page);
  await focusShell(page);
  const rebound = await db1(page, (h) => ({
    embeds: h.runtime!.binding.embeds,
    inHost: h.runtime!.binding.element.parentElement?.dataset.testid ===
      "db-console",
  }), null);
  expect(rebound).toEqual({ embeds: 1, inHost: true });
  expect(duckDbWorkers(page)).toBe(1);
  expect(await shellListeners()).toEqual(["window:resize", "window:resize"]);
  expect(await screen(page)).toContain("DuckDB Web Shell");

  // The shell is bound to the new instance (fresh in-memory database), both
  // directions.
  await typeLine(page, "SHOW TABLES;");
  const tables = outputOf(await screen(page), "SHOW TABLES;");
  expect(tables).toContain("│ tasks │");
  expect(tables).not.toContain("first_instance");
  await db1(
    page,
    (h) =>
      h.execute(
        "INSERT INTO tasks (title, created_at) VALUES ('second generation', 'now')",
      ),
    null,
  );
  await typeLine(page, "SELECT title FROM tasks WHERE id = 4;");
  expect(outputOf(await screen(page), "SELECT title FROM tasks WHERE id = 4;"))
    .toContain("second generation");
  await typeLine(page, "CREATE TABLE second_instance AS SELECT 2 AS y;");
  expect(await db1(page, (h) => h.tables(), null)).toEqual([
    "second_instance",
    "tasks",
  ]);
  expect(
    await db1(page, (h) => h.changes.filter((c) => c.source === "shell"), null),
  ).toEqual([
    { kind: "write", source: "shell", changes: 1, schemaChanged: true },
  ]);
  log.push(
    `generation ${second} open: duckdbWorkers=${
      duckDbWorkers(page)
    } shell listeners ${JSON.stringify(await shellListeners())}\n${await screen(
      page,
    )}`,
  );
  await screenshot(page, "08-instance-reopened");

  // Close again: every DuckDB worker this page started has closed.
  await page.getByTestId("instance-close").click();
  await expect.poll(() => duckDbWorkers(page)).toBe(0);
  await expect.poll(() => closed.length).toBe(2);
  expect(started.length).toBe(2);
  expect(await shellListeners()).toEqual([]);
  log.push(
    `closed again: duckdb workers started=${started.length} closed=${closed.length} shell listeners ${
      JSON.stringify(await shellListeners())
    }`,
  );

  // Closed while DuckDB is still starting: whatever the start acquires after
  // the close is released as it is added, so its worker closes too.
  await page.getByTestId("instance-reopen").click();
  await loadPlaygroundHooks(page);
  await page.getByTestId("db1-open").click();
  await page.getByTestId("instance-close").click();
  await expect.poll(() => started.length, { timeout: 30_000 }).toBe(3);
  await expect.poll(() => closed.length, { timeout: 30_000 }).toBe(3);
  await page.waitForTimeout(2000);
  expect(duckDbWorkers(page)).toBe(0);
  expect(await shellListeners()).toEqual([]);
  log.push(
    `closed while starting: duckdb workers started=${started.length} closed=${closed.length}`,
  );

  // The page's one shell slot is free again: the next instance embeds.
  await page.getByTestId("instance-reopen").click();
  await loadPlaygroundHooks(page);
  await openInstance(page);
  expect(await shellListeners()).toEqual(["window:resize", "window:resize"]);
  await focusShell(page);
  await typeLine(page, "SELECT count(*) AS n FROM tasks;");
  expect(outputOf(await screen(page), "SELECT count(*) AS n FROM tasks;"))
    .toMatch(/│\s+3 │/);
  log.push(
    `generation ${await generation()} open: duckdbWorkers=${
      duckDbWorkers(page)
    } shell listeners ${JSON.stringify(await shellListeners())}`,
  );
  saveEvidence(`08-instance-reopen-${target}.txt`, log.join("\n") + "\n");
  expect(problems).toEqual([]);
});
