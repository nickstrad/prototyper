// R6 resource disposal (plan.md Q18, §10b R6): closing the event analytics
// (its own Close control, or the whole playground instance through
// `window.__playgroundLifecycle`) disposes the shell's terminal and
// terminates the DuckDB worker; page.workers() returns to its baseline and
// the window/document listener lists (DevTools) match the pristine page after
// each of six cycles. Hiding the Database view keeps the one embedded shell
// and the worker.
import { expect, type Page, test } from "@playwright/test";
import { SEED_EVENT_COUNT } from "../../prototypes/event-analytics/seed.ts";
import { AGGREGATE_SQL } from "../../prototypes/event-analytics/queries.ts";
import {
  collectProblems,
  disposals,
  duckDbWorkers,
  inst,
  instanceReady,
  liveListeners,
  loadHooks,
  loadPlayground,
  openAnalytics,
  openDatabaseView,
  releaseDb1,
  saveEvidence,
  section,
  settledListeners,
  shellElement,
  shellQuery,
  starts,
  target,
  trackShellListeners,
} from "./helpers.ts";

test.describe.configure({ timeout: 480_000 });

type LifecycleWindow = {
  __playgroundLifecycle: { close(): void; reopen(): void };
};

/** Open terminals per playground section (each xterm holds listeners). */
const terminals = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll(".xterm")].map((x) =>
      x.closest("section")?.querySelector("[data-testid]")?.getAttribute(
        "data-testid",
      ) ?? x.closest("[data-testid]")?.getAttribute("data-testid") ?? "?"
    ).join(",")
  );

const closeViaLifecycle = async (page: Page) => {
  await page.evaluate(() =>
    (globalThis as unknown as LifecycleWindow).__playgroundLifecycle.close()
  );
  await expect(page.getByTestId("instance-reopen")).toBeEnabled();
  await page.evaluate(() =>
    (globalThis as unknown as LifecycleWindow).__playgroundLifecycle.reopen()
  );
  await loadHooks(page);
  await instanceReady(page);
  await releaseDb1(page);
};

test("six open/close cycles terminate the worker and leak no window/document listeners", async ({ page }) => {
  const problems = collectProblems(page);
  const cdp = await page.context().newCDPSession(page);
  const tracked = await trackShellListeners(cdp);
  const shellListeners = tracked.shell;
  const started: string[] = [];
  const closed: string[] = [];
  page.on("worker", (w) => {
    if (!w.url().includes("duckdb")) return; // the playground's Fiddle workers
    started.push(w.url());
    w.on("close", () => closed.push(w.url()));
  });
  await loadPlayground(page);
  const pristine = await settledListeners(cdp, page);
  const baselineWorkers = duckDbWorkers(page);
  expect(baselineWorkers).toBe(0);
  const log = [
    `pristine (nothing DuckDB loaded): duckdbWorkers=${baselineWorkers} ${
      JSON.stringify(pristine)
    }`,
    `  by script: ${JSON.stringify(await tracked.all())}`,
    `  terminals: ${await terminals(page)}; r4: ${await page.getByTestId(
      "r4-editor-status",
    ).textContent()}`,
  ];

  for (let cycle = 1; cycle <= 6; cycle++) {
    const via = cycle % 2 === 1 ? "r6-close" : "__playgroundLifecycle";
    await openAnalytics(page);
    await openDatabaseView(page);
    expect(duckDbWorkers(page)).toBe(baselineWorkers + 1);
    const whileOpen = await shellListeners();
    expect(whileOpen).toEqual(["window:resize", "window:resize"]);
    const totals = await shellQuery(page, AGGREGATE_SQL.totals);
    expect(totals.rows[0]?.[0]).toBe(String(SEED_EVENT_COUNT));

    // Hide/show moves the one embedded shell; the worker stays.
    await section(page).getByTestId("r6-db-toggle").click();
    await expect(section(page).getByTestId("db-editor")).toHaveCount(0);
    expect(await inst(page, (h) => h.binding()!.element.isConnected, null))
      .toBe(false);
    await section(page).getByTestId("r6-db-toggle").click();
    await expect(shellElement(page).locator(".xterm")).toBeVisible();
    expect(await inst(page, (h) => h.binding()!.embeds, null)).toBe(1);
    expect(duckDbWorkers(page)).toBe(baselineWorkers + 1);

    const before = await disposals(page);
    if (via === "r6-close") await section(page).getByTestId("r6-close").click();
    else await closeViaLifecycle(page);
    await expect.poll(() => duckDbWorkers(page), { timeout: 30_000 })
      .toBe(baselineWorkers);
    await expect.poll(() => disposals(page), { timeout: 30_000 })
      .toBe(before + 1);
    await expect.poll(() => shellListeners(), { timeout: 30_000 }).toEqual([]);
    await expect(section(page).getByTestId("r6-closed")).toBeVisible();
    const now = await settledListeners(cdp, page);
    log.push(
      `cycle ${cycle} (closed via ${via}): open shell listeners ${
        JSON.stringify(whileOpen)
      }; after close duckdbWorkers=${
        duckDbWorkers(page)
      } started=${started.length} closed=${closed.length} ${
        JSON.stringify(now)
      }`,
    );
    log.push(
      `  terminals: ${await terminals(page)}; r4: ${await page.getByTestId(
        "r4-editor-status",
      ).textContent()}`,
    );
    if (JSON.stringify(now) !== JSON.stringify(pristine)) {
      log.push(`  by script: ${JSON.stringify(await tracked.all())}`);
    }
    saveEvidence(`05-lifecycle-${target}.txt`, log.join("\n") + "\n");
    // Exactly the pristine lists (instanceReady waits for the other
    // slices' consoles, each holding one xterm DPR "resize" listener).
    expect(now).toEqual(pristine);
  }
  expect(started).toHaveLength(6);
  expect(closed).toHaveLength(6);
  log.push(`final live listeners: ${JSON.stringify(await liveListeners(cdp))}`);
  saveEvidence(`05-lifecycle-${target}.txt`, log.join("\n") + "\n");
  expect(problems).toEqual([]);
});

test("closing while the Database view is still starting (DB1 owns the shell) releases everything", async ({ page }) => {
  // Review 01 finding 1: the binding rejects (Q18 page singleton) while the
  // analytics closes; the cleanup must still terminate R6's worker.
  const problems = collectProblems(page);
  await loadPlayground(page);
  await page.getByTestId("db1-open").click();
  await expect(page.getByTestId("db1-status")).toContainText("engine ready", {
    timeout: 90_000,
  });
  const db1Workers = duckDbWorkers(page);
  expect(db1Workers).toBe(1);
  const log: string[] = [];
  for (const via of ["r6-close", "__playgroundLifecycle"] as const) {
    await openAnalytics(page);
    expect(duckDbWorkers(page)).toBe(db1Workers + 1);
    const before = await disposals(page);
    // "Open database view" and the close in the same task, so the close
    // runs while the binding is still starting (and then rejects, Q18).
    await page.evaluate((how) => {
      const button = (id: string) =>
        document.querySelector<HTMLButtonElement>(
          `[data-testid="r6-workbench"] [data-testid="${id}"]`,
        )!;
      button("r6-db-toggle").click();
      if (how === "r6-close") button("r6-close").click();
      else {
        (globalThis as unknown as {
          __playgroundLifecycle: { close(): void };
        }).__playgroundLifecycle.close();
      }
    }, via);
    if (via === "__playgroundLifecycle") {
      await expect(page.getByTestId("instance-reopen")).toBeEnabled();
      await page.evaluate(() =>
        (globalThis as unknown as LifecycleWindow).__playgroundLifecycle
          .reopen()
      );
      await loadHooks(page);
      await instanceReady(page);
    }
    // DB1's instance is closed with the playground instance, R6's always.
    const expectedWorkers = via === "r6-close" ? db1Workers : 0;
    await expect.poll(() => duckDbWorkers(page), { timeout: 30_000 })
      .toBe(expectedWorkers);
    await expect.poll(() => disposals(page), { timeout: 30_000 })
      .toBe(before + 1);
    expect(await disposals(page)).toBe(await starts(page));
    log.push(
      `closed via ${via}: duckdbWorkers=${
        duckDbWorkers(page)
      } disposals=${await disposals(
        page,
      )} starts=${await starts(page)}`,
    );
    if (via === "r6-close") {
      // The page still works: the view reports the singleton, then closes.
      await openAnalytics(page);
      await section(page).getByTestId("r6-db-toggle").click();
      await expect(section(page).getByTestId("r6-db-error")).toContainText(
        "page singleton",
        { timeout: 60_000 },
      );
      await section(page).getByTestId("r6-close").click();
      await expect.poll(() => duckDbWorkers(page), { timeout: 30_000 })
        .toBe(db1Workers);
    }
  }
  saveEvidence(
    `07-close-during-view-start-${target}.txt`,
    log.join("\n") + "\n",
  );
  expect(problems).toEqual([]);
});

test("closing while DuckDB is still starting releases everything cleanly", async ({ page }) => {
  const problems = collectProblems(page);
  await loadPlayground(page);
  for (const delay of [0, 300, 1500]) {
    await section(page).getByTestId("r6-open").click();
    await page.waitForTimeout(delay);
    await section(page).getByTestId("r6-close").click();
    // Every instance that started DuckDB was released (a close before the
    // deferred start never starts one).
    await expect.poll(
      async () => (await disposals(page)) === (await starts(page)),
      { timeout: 60_000 },
    ).toBe(true);
    await expect.poll(() => duckDbWorkers(page), { timeout: 30_000 }).toBe(0);
  }
  expect(await starts(page)).toBeGreaterThan(0);
  // Still usable afterwards.
  await openAnalytics(page);
  await expect(section(page).getByTestId("r6-total-events")).toHaveText(
    String(SEED_EVENT_COUNT),
  );
  await section(page).getByTestId("r6-close").click();
  await expect.poll(() => duckDbWorkers(page), { timeout: 30_000 }).toBe(0);
  expect(problems).toEqual([]);
});
