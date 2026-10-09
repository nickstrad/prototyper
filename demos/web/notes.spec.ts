import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/demos/web/");
  await expect(page.getByTestId("note-1")).toContainText(
    "Welcome to your notes.",
    { timeout: 60_000 },
  );
});
test("SQLite notes create edit delete", async ({ page }) => {
  await expect(page.getByRole("navigation").getByRole("button")).toHaveText([
    "Application",
    "Database",
  ]);
  await page.getByLabel("New note", { exact: true }).fill(
    "Nick's note; SELECT 1;",
  );
  await page.getByRole("button", { name: "Create note", exact: true }).click();
  await expect(page.getByTestId("note-3")).toContainText(
    "Nick's note; SELECT 1;",
  );
  await page.getByTestId("note-3").getByRole("button", {
    name: "Edit",
    exact: true,
  }).click();
  await page.getByLabel("Edit note", { exact: true }).fill(
    "Edited\nsecond line",
  );
  await page.getByRole("button", { name: "Save note", exact: true }).click();
  await expect(page.getByTestId("note-3")).toContainText("Edited\nsecond line");
  await page.getByTestId("note-3").getByRole("button", {
    name: "Delete",
    exact: true,
  }).click();
  await expect(page.getByTestId("note-3")).toHaveCount(0);
});
test("shell UPDATE refreshes hidden UI without polling", async ({ page }) => {
  const before = await page.getByTestId("loads").textContent();
  await page.waitForTimeout(1000);
  await expect(page.getByTestId("loads")).toHaveText(before!);
  await page.getByRole("button", { name: "Database", exact: true }).click();
  const terminal = page.locator(".xterm-helper-textarea");
  await terminal.focus();
  await page.keyboard.type(
    "UPDATE notes SET body = 'Shell changed it' WHERE id = 1;",
  );
  await page.keyboard.press("Enter");
  // Assert before returning to Application: switching tabs cannot cause the refresh.
  await expect(page.getByTestId("note-1")).toContainText("Shell changed it");
  const after = await page.getByTestId("loads").textContent();
  expect(Number(after)).toBeGreaterThan(Number(before));
  await page.waitForTimeout(1000);
  await expect(page.getByTestId("loads")).toHaveText(after!);
  await page.getByRole("button", { name: "Application", exact: true }).click();
  await expect(page.getByTestId("note-1")).toBeVisible();
});
test("reset restores exact seed after create edit delete", async ({ page }) => {
  await page.getByTestId("note-1").getByRole("button", {
    name: "Delete",
    exact: true,
  }).click();
  await page.getByTestId("note-2").getByRole("button", {
    name: "Edit",
    exact: true,
  }).click();
  await page.getByLabel("Edit note", { exact: true }).fill("Changed seed");
  await page.getByRole("button", { name: "Save note", exact: true }).click();
  await expect(page.getByTestId("note-2")).toContainText("Changed seed");
  await page.getByLabel("New note", { exact: true }).fill("Extra note");
  await page.getByRole("button", { name: "Create note", exact: true }).click();
  await expect(page.getByTestId("note-3")).toBeVisible();
  await page.getByRole("button", { name: "Reset notes", exact: true }).click();
  await expect(page.locator("li")).toHaveCount(2);
  await expect(page.getByTestId("note-1")).toContainText(
    "Welcome to your notes.",
  );
  await expect(page.getByTestId("note-2")).toContainText(
    "Try editing a note from the Database shell.",
  );
});
test("desktop and narrow screenshots", async ({ page }) => {
  await page.screenshot({ path: "/tmp/r12-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "/tmp/r12-narrow.png", fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    390,
  );
  await page.getByRole("button", { name: "Database", exact: true }).click();
  await expect(page.locator(".xterm")).toBeVisible();
  await page.screenshot({ path: "/tmp/r12-database.png", fullPage: true });
});

test("both reset controls clear an active unsaved edit draft", async ({ page }) => {
  const beginDraft = async () => {
    await page.getByTestId("note-1").getByRole("button", {
      name: "Edit",
      exact: true,
    }).click();
    await page.getByLabel("Edit note", { exact: true }).fill("Unsaved draft");
  };
  const expectClearedDraft = async () => {
    await expect(page.getByLabel("New note", { exact: true })).toHaveValue("");
    await expect(page.getByRole("button", { name: "Create note" }))
      .toBeVisible();
    await expect(page.getByRole("button", { name: "Save note" })).toHaveCount(
      0,
    );
  };

  await beginDraft();
  await page.getByRole("button", { name: "Database", exact: true }).click();
  await page.getByTestId("db-reset").click();
  await expect(page.getByText("database reset to its seed")).toBeVisible();
  await page.getByRole("button", { name: "Application", exact: true }).click();
  await expectClearedDraft();

  await beginDraft();
  await page.getByRole("button", { name: "Reset notes", exact: true }).click();
  await expectClearedDraft();
});

test("reload disclosure matches the seeded in-memory session behavior", async ({ page }) => {
  await page.getByLabel("New note", { exact: true }).fill("Third note");
  await page.getByRole("button", { name: "Create note", exact: true }).click();
  await expect(page.getByTestId("note-3")).toBeVisible();
  await expect(page.locator("footer")).toContainText(
    "Reloading discards changes and starts a new session with the two seeded notes.",
  );
  await page.reload();
  await expect(page.getByTestId("note-1")).toBeVisible();
  await expect(page.getByTestId("note-2")).toBeVisible();
  await expect(page.locator("li")).toHaveCount(2);
  await expect(page.getByTestId("note-3")).toHaveCount(0);
});
