// Prototype-instance lifecycle in the browser (R4 done-when): closing and
// reopening the instance leaks no workers or listeners; hiding and showing
// panels ("tab changes") creates no worker and duplicates no notification;
// one write still produces exactly one UI reload and one change event.
import { expect, test } from "@playwright/test";
import {
  apiCall,
  collectProblems,
  d1Events,
  generation,
  installListenerCounter,
  instanceReady,
  r1Loads,
  stableListenerCounts,
  workers,
} from "./helpers.ts";

test.describe.configure({ mode: "serial" });

test("close/reopen six times: workers and listeners return to their baselines", async ({ page }) => {
  test.setTimeout(240_000);
  const problems = collectProblems(page);
  await installListenerCounter(page);
  await page.goto("/");
  await instanceReady(page);

  // Warm-up cycle: lazily created singletons (xterm caches, fonts) settle.
  await page.getByTestId("instance-close").click();
  await expect(page.getByTestId("instance-controls")).toContainText("closed");
  await expect.poll(() =>
    page.evaluate(() =>
      !("__playground" in globalThis) ||
      (globalThis as unknown as { __playground?: unknown }).__playground ===
        undefined
    )
  ).toBe(true);
  await page.getByTestId("instance-reopen").click();
  await instanceReady(page);

  const openWorkers = workers(page);
  const openListeners = await stableListenerCounts(page);
  await page.getByTestId("instance-close").click();
  await expect.poll(() => workers(page), { timeout: 30_000 }).toBeLessThan(
    openWorkers,
  );
  await expect.poll(() => workers(page), { timeout: 30_000 }).toBe(0);
  const closedWorkers = workers(page);
  expect(closedWorkers, "a closed instance leaves no engine worker").toBe(0);
  const closedListeners = await stableListenerCounts(page);
  await page.getByTestId("instance-reopen").click();
  await instanceReady(page);

  const trace: Record<string, unknown>[] = [{
    phase: "baseline",
    openWorkers,
    openListeners,
    closedWorkers,
    closedListeners,
  }];
  for (let cycle = 1; cycle <= 6; cycle++) {
    await page.getByTestId("instance-close").click();
    await expect.poll(() => workers(page), { timeout: 30_000 }).toBe(
      closedWorkers,
    );
    const closedNow = await stableListenerCounts(page);
    await page.getByTestId("instance-reopen").click();
    await instanceReady(page);
    const openNow = await stableListenerCounts(page);
    trace.push({ cycle, closedNow, openWorkers: workers(page), openNow });
    expect(closedNow, `listeners while closed, cycle ${cycle}`).toEqual(
      closedListeners,
    );
    expect(workers(page), `workers while open, cycle ${cycle}`).toBe(
      openWorkers,
    );
    expect(openNow, `listeners while open, cycle ${cycle}`).toEqual(
      openListeners,
    );
  }
  console.log("---- lifecycle trace ----\n" + JSON.stringify(trace, null, 1));
  expect(await generation(page)).toBe(9);

  // The reopened instance starts at the seed and one write means one reload.
  await expect(page.getByTestId("r1-tasks").locator("li")).toHaveCount(3);
  const loads = await r1Loads(page);
  const events = await d1Events(page);
  const created = await apiCall(
    page,
    "POST",
    "/tasks",
    JSON.stringify({ title: "after reopen" }),
  );
  expect(created.status).toBe(201);
  await expect.poll(() => r1Loads(page)).toBe(loads + 1);
  await expect.poll(() => d1Events(page)).toBe(events + 1);
  await page.waitForTimeout(500);
  expect(await r1Loads(page)).toBe(loads + 1);
  expect(problems).toEqual([]);
});

test("tab changes: hiding and showing panels creates no worker and duplicates no notification", async ({ page }) => {
  test.setTimeout(180_000);
  const problems = collectProblems(page);
  await installListenerCounter(page);
  await page.goto("/");
  await instanceReady(page);
  const baseWorkers = workers(page);
  const baseListeners = await stableListenerCounts(page);

  // Task manager panel: hide/show three times, twice through the UI button
  // and once through the instance hooks (`__playground.r4`).
  for (let i = 0; i < 3; i++) {
    if (i === 2) {
      await page.evaluate(() =>
        (globalThis as unknown as {
          __playground: { r4: { toggleTasksPanel(): void } };
        })
          .__playground.r4.toggleTasksPanel()
      );
    } else {
      await page.getByTestId("r4-tasks-toggle").click();
    }
    await expect(page.getByTestId("r1-task-manager")).toHaveCount(0);
    expect(
      await page.evaluate(() =>
        (globalThis as unknown as {
          __playground: { r4: { tasksPanelVisible(): boolean } };
        })
          .__playground.r4.tasksPanelVisible()
      ),
    ).toBe(false);
    await page.getByTestId("r4-tasks-toggle").click();
    await instanceReady(page);
  }
  expect(workers(page)).toBe(baseWorkers);
  expect(await stableListenerCounts(page), "listeners after task-panel toggles")
    .toEqual(baseListeners);

  // Shared-engine editor: hide/show three times when it is bound.
  const editorBound = await page.evaluate(() =>
    Boolean(
      (globalThis as unknown as { __playground: { r4: { editor(): unknown } } })
        .__playground.r4.editor(),
    )
  );
  if (editorBound) {
    for (let i = 0; i < 3; i++) {
      await page.getByTestId("r4-editor-toggle").click();
      await page.getByTestId("r4-editor-toggle").click();
    }
    await expect(page.getByTestId("r4-editor-status")).toContainText("bound");
    expect(workers(page)).toBe(baseWorkers);
    expect(await stableListenerCounts(page), "listeners after editor toggles")
      .toEqual(baseListeners);
  } else {
    test.info().annotations.push({
      type: "note",
      description:
        "shared-engine editor not bound (D1 workbench exposes no client yet); editor tab changes not exercised",
    });
  }

  // Exactly one reload and one change event per write after all that toggling.
  const loads = await r1Loads(page);
  const events = await d1Events(page);
  await page.getByTestId("terminal").locator(".xterm").click();
  await page.keyboard.type('tasks create "after toggles"');
  await page.keyboard.press("Enter");
  await expect.poll(() => r1Loads(page)).toBe(loads + 1);
  await expect.poll(() => d1Events(page)).toBe(events + 1);
  await page.waitForTimeout(500);
  expect(await r1Loads(page)).toBe(loads + 1);
  expect(await d1Events(page)).toBe(events + 1);
  await expect(page.getByTestId("r1-tasks")).toContainText("after toggles");
  expect(problems).toEqual([]);
});
