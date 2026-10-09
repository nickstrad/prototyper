import { expect, type Page, test } from "@playwright/test";
import type { EventAnalyticsInstanceHooks } from "../../prototypes/event-analytics/App.tsx";
import { SEED_EVENTS } from "../../prototypes/event-analytics/seed.ts";
import { expectedOverview } from "../duckdb/oracle.ts";

// Deliberately independent of the registry: dropping a build entry must fail.
const entries = ["cli", "api", "web", "combined", "analytics"];

async function line(page: Page, testid: string, sql: string) {
  await page.getByTestId(testid).locator("textarea").focus();
  await page.keyboard.type(sql);
  await page.keyboard.press("Enter");
}

// Read the upstream terminal buffer; its canvas renderer need not mirror DOM text.
const analyticsScreen = (page: Page) =>
  page.evaluate(() =>
    (window as Window & { __analytics?: EventAnalyticsInstanceHooks })
      .__analytics?.screen() ?? ""
  );

test("gallery links every demo", async ({ page }, info) => {
  await page.goto("/demos/");
  await expect(page.locator("#demos a")).toHaveCount(5);
  for (const id of entries) {
    await expect(page.locator(`#demos a[href='/demos/${id}/']`)).toHaveCount(1);
  }
  await page.screenshot({
    path: info.outputPath("gallery-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: info.outputPath("gallery-mobile.png"),
    fullPage: true,
  });
  expect(
    await page.evaluate(() =>
      document.documentElement.scrollWidth <= innerWidth
    ),
  ).toBe(true);
});

for (const id of entries) {
  test(
    `${id} runs with external network blocked`,
    async ({ page, context, baseURL }, info) => {
      test.setTimeout(180_000);
      const external: string[] = [];
      const errors: string[] = [];
      const failed: string[] = [];
      const origin = new URL(baseURL!).origin;
      await context.route((url) => url.origin !== origin, (route) => {
        external.push(route.request().url());
        return route.abort();
      });
      page.on("pageerror", (e) => errors.push(String(e)));
      page.on("response", (r) => {
        if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`);
      });
      const response = await page.goto(`/demos/${id}/`);
      expect(response?.status()).toBe(200);
      // A directory listing is not a built application entry.
      expect(await response?.text()).toContain('type="module"');
      expect(response?.headers()["cross-origin-opener-policy"]).toBeUndefined();
      expect(response?.headers()["cross-origin-embedder-policy"])
        .toBeUndefined();
      if (id === "cli") {
        await expect(page.getByRole("status")).toContainText(
          "reload restores the seed",
          { timeout: 60_000 },
        );
        await line(
          page,
          "inventory-terminal",
          'inventory add offline "Offline stock" 7',
        );
        await expect(page.getByTestId("inventory-terminal")).toContainText(
          "Offline stock",
        );
        await line(page, "db-console", ".mode list");
        await line(
          page,
          "db-console",
          "SELECT quantity FROM inventory WHERE sku = 'offline';",
        );
        await expect(page.getByTestId("db-console")).toContainText("7");
      } else if (id === "api") {
        await expect(page.getByRole("button", { name: "Send", exact: true }))
          .toBeEnabled({ timeout: 60_000 });
        await page.getByLabel("Method", { exact: true }).selectOption("POST");
        await page.getByLabel("Path", { exact: true }).fill("/bookmarks");
        await page.getByLabel("JSON body").fill(
          '{"title":"Offline bookmark","url":"https://example.com"}',
        );
        await page.getByRole("button", { name: "Send", exact: true }).click();
        await expect(page.getByTestId("response-status")).toContainText("201");
        await page.getByRole("button", { name: "Database", exact: true })
          .click();
        await expect(page.getByTestId("db-preview")).toContainText(
          "Offline bookmark",
        );
        await line(page, "db-console", ".schema bookmarks");
        await expect(page.getByTestId("db-console")).toContainText(
          "CREATE TABLE",
        );
      } else if (id === "web") {
        await expect(page.getByTestId("note-1")).toBeVisible({
          timeout: 60_000,
        });
        await page.getByLabel("New note", { exact: true }).fill("Offline note");
        await page.getByRole("button", { name: "Create note", exact: true })
          .click();
        await expect(page.getByTestId("note-3")).toContainText("Offline note");
        await page.getByRole("button", { name: "Database", exact: true })
          .click();
        await line(
          page,
          "db-console",
          "UPDATE notes SET body = 'SQL offline' WHERE id = 3;",
        );
        await expect(page.getByTestId("note-3")).toContainText("SQL offline");
      } else if (id === "combined") {
        await expect(page.getByTestId("r1-task-3")).toBeVisible({
          timeout: 60_000,
        });
        await line(page, "combined-terminal", 'tasks create "Offline task"');
        await expect(page.getByTestId("r1-task-4")).toContainText(
          "Offline task",
        );
        await page.getByTestId("r3-method").selectOption("POST");
        await page.getByTestId("r3-path").fill("/tasks/4/complete");
        await page.getByTestId("r3-send").click();
        await expect(page.getByTestId("r1-task-4").getByRole("checkbox"))
          .toBeChecked();
        await line(page, "db-console", ".mode list");
        await line(
          page,
          "db-console",
          "SELECT title, completed FROM tasks WHERE id = 4;",
        );
        await expect(page.getByTestId("db-console")).toContainText(
          "Offline task|1",
        );
      } else {
        const seed = expectedOverview(SEED_EVENTS);
        await expect(page.getByTestId("r6-total-events")).toHaveText(
          String(seed.totals.events),
          { timeout: 60_000 },
        );
        await expect(page.getByTestId("r6-total-views")).toHaveText(
          String(seed.totals.views),
        );
        await expect(page.getByTestId("r6-total-signups")).toHaveText(
          String(seed.totals.signups),
        );
        await expect(page.getByTestId("r6-total-revenue")).toHaveText(
          seed.totals.revenue,
        );
        await expect(page.getByTestId("r6-per-day").locator("tbody tr"))
          .toHaveCount(14);
        await expect(page.getByTestId("r6-sources").locator("tbody tr"))
          .toHaveCount(5);
        await expect(page.getByTestId("r6-countries").locator("tbody tr"))
          .toHaveCount(5);
        const before = await page.getByTestId("r6-notifications").innerText();
        await page.getByTestId("r6-db-toggle").click();
        await expect(page.getByTestId("db-console").locator("textarea"))
          .toBeVisible({ timeout: 60_000 });
        await expect.poll(() => analyticsScreen(page), { timeout: 60_000 })
          .toContain("duckdb>");
        await line(
          page,
          "db-console",
          "SELECT count(*) AS offline_count FROM events;",
        );
        await expect.poll(() => analyticsScreen(page)).toContain(
          "offline_count",
        );
        await expect.poll(() => analyticsScreen(page)).toContain("360");
        await expect(page.getByTestId("r6-notifications")).toHaveText(before);
        await line(
          page,
          "db-console",
          "INSERT INTO events (occurred_on, kind, country, source, user_id, revenue) VALUES ('2026-09-15', 'signup', 'US', 'offline', 9001, 9.99);",
        );
        await expect(page.getByTestId("r6-total-events")).toHaveText("361");
        await expect(page.getByTestId("r6-total-signups")).toHaveText(
          String(seed.totals.signups + 1),
        );
        await expect(page.getByTestId("r6-per-day").locator("tbody tr"))
          .toHaveCount(15);
        await expect(page.getByTestId("r6-notifications")).toContainText(
          "change notifications 1",
        );
        await page.getByTestId("r6-reset").click();
        await expect(page.getByTestId("r6-total-events")).toHaveText("360");
        await expect(page.getByTestId("r6-total-revenue")).toHaveText(
          seed.totals.revenue,
        );
        await line(
          page,
          "db-console",
          "SELECT count(*) AS reset_count FROM events;",
        );
        await expect(page.getByTestId("db-console")).toContainText(
          "reset_count",
        );
      }
      await page.screenshot({
        path: info.outputPath(`${id}-desktop.png`),
        fullPage: true,
      });
      if (id === "analytics") {
        await page.setViewportSize({ width: 390, height: 844 });
        await expect(page.getByTestId("db-console")).toHaveCSS(
          "overflow-x",
          "auto",
        );
        const consoleScroll = await page.getByTestId("db-console").evaluate(
          (element) => {
            const wide = element.scrollWidth > element.clientWidth;
            element.scrollLeft = 64;
            const reachable = !wide || element.scrollLeft > 0;
            element.scrollLeft = 0;
            return reachable;
          },
        );
        expect(consoleScroll).toBe(true);
        await page.screenshot({
          path: info.outputPath("analytics-mobile.png"),
          fullPage: true,
        });
        expect(
          await page.evaluate(() =>
            document.documentElement.scrollWidth <= innerWidth
          ),
        ).toBe(true);
      }
      expect(external).toEqual([]);
      expect(failed).toEqual([]);
      expect(errors).toEqual([]);
    },
  );
}
