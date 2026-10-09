import { expect, type Page, test } from "@playwright/test";

async function open(page: Page) {
  await page.goto("/demos/combined/");
  await expect(page.getByTestId("r1-task-3")).toBeVisible({ timeout: 45_000 });
  await expect(page.getByTestId("r3-send")).toBeEnabled();
}

async function terminal(page: Page, command: string) {
  const host = page.getByTestId("combined-terminal");
  await host.locator("textarea").focus();
  await page.keyboard.type(command);
  await page.keyboard.press("Enter");
}

async function api(page: Page, method: string, path: string, body = "") {
  await page.getByTestId("r3-method").selectOption(method);
  await page.getByTestId("r3-path").fill(path);
  await page.getByTestId("r3-body").fill(body);
  await page.getByTestId("r3-send").click();
}

async function sql(page: Page, command: string) {
  const host = page.getByTestId("db-console");
  await host.locator("textarea").focus();
  await page.keyboard.type(command);
  await page.keyboard.press("Enter");
}

test(
  "walkthrough: CLI create → API complete → Application and upstream shell inspect",
  async ({ page }, info) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    await open(page);
    expect(page.workers()).toHaveLength(1);
    await terminal(page, 'tasks create "Ship combined demo"');
    await expect(page.getByTestId("combined-terminal")).toContainText(
      "created 4: Ship combined demo",
    );
    await expect(page.getByTestId("r1-task-4")).toHaveAttribute(
      "data-completed",
      "false",
    );
    await api(page, "POST", "/tasks/4/complete");
    await expect(page.getByTestId("r3-response-status")).toContainText("200");
    await expect(page.getByTestId("r3-response-body")).toContainText(
      '"completed": true',
    );
    await expect(page.getByTestId("r1-task-4")).toContainText(
      "Ship combined demo",
    );
    await expect(page.getByTestId("r1-task-4").getByRole("checkbox"))
      .toBeChecked();
    await sql(page, ".mode list");
    await sql(page, "SELECT id, title, completed FROM tasks WHERE id = 4;");
    await expect(page.getByTestId("db-console")).toContainText(
      "4|Ship combined demo|1",
    );
    await terminal(page, "tasks get 4 --json");
    await expect(page.getByTestId("combined-terminal")).toContainText(
      '"completed":true',
    );
    await page.screenshot({
      path: info.outputPath("desktop.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: info.outputPath("mobile.png"),
      fullPage: true,
    });
    expect(
      await page.evaluate(() =>
        document.documentElement.scrollWidth <= innerWidth
      ),
    ).toBe(true);
    expect(errors).toEqual([]);
  },
);

test("all four views share edits in both directions and reset", async ({ page }) => {
  await open(page);
  await sql(
    page,
    "UPDATE tasks SET title = 'Shell edit', completed = 1 WHERE id = 2;",
  );
  await expect(page.getByTestId("r1-task-2")).toContainText("Shell edit");
  await expect(page.getByTestId("r1-task-2").getByRole("checkbox"))
    .toBeChecked();
  await api(page, "GET", "/tasks/2");
  await expect(page.getByTestId("r3-response-body")).toContainText(
    '"title": "Shell edit"',
  );
  await terminal(page, "tasks get 2");
  await expect(page.getByTestId("combined-terminal")).toContainText(
    "[x] Shell edit",
  );
  await page.getByTestId("r1-title").fill("UI edit");
  await page.getByTestId("r1-add").click();
  await expect(page.getByTestId("r1-task-4")).toContainText("UI edit");
  await sql(page, ".mode list");
  await sql(page, "SELECT title FROM tasks WHERE id = 4;");
  await expect(page.getByTestId("db-console")).toContainText("UI edit");
  await api(page, "GET", "/tasks/4");
  await expect(page.getByTestId("r3-response-body")).toContainText(
    '"title": "UI edit"',
  );
  await terminal(page, "tasks get 4");
  await expect(page.getByTestId("combined-terminal")).toContainText(
    "[ ] UI edit",
  );
  await page.getByTestId("r1-reset").click();
  await expect(page.getByTestId("r1-task-4")).toHaveCount(0);
  await api(page, "GET", "/tasks/4");
  await expect(page.getByTestId("r3-response-status")).toContainText("404");
  await terminal(page, "tasks get 4");
  await expect(page.getByTestId("combined-terminal")).toContainText(
    "task 4 not found",
  );
  await sql(page, "SELECT 'seed-count=' || count(*) FROM tasks;");
  await expect(page.getByTestId("db-console")).toContainText(
    "seed-count=3",
  );
});

test("R1 domain validation is reused by CLI, API and Application", async ({ page }) => {
  await open(page);
  await terminal(page, 'tasks create "   "');
  await expect(page.getByTestId("combined-terminal")).toContainText(
    "title is required",
  );
  await api(page, "POST", "/tasks", '{"title":"   "}');
  await expect(page.getByTestId("r3-response-status")).toContainText("400");
  await expect(page.getByTestId("r3-response-body")).toContainText(
    "InvalidInput",
  );
  await page.getByTestId("r1-title").fill("   ");
  await page.getByTestId("r1-add").click();
  await expect(page.getByTestId("r1-error")).toContainText("title is required");
  await expect(page.getByTestId("r1-task-4")).toHaveCount(0);
  await terminal(page, 'tasks create "  Trimmed by R1  "');
  await expect(page.getByTestId("r1-task-4")).toContainText("Trimmed by R1");
  await api(page, "GET", "/tasks/4");
  await expect(page.getByTestId("r3-response-body")).toContainText(
    '"title": "Trimmed by R1"',
  );
});
