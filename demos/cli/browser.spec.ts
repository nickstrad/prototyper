import { expect, type Page, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import process from "node:process";
import { resolve } from "node:path";
const evidence = resolve(
  process.cwd(),
  process.env.PW_OUT ?? "test-results-r10",
);
async function command(page: Page, line: string) {
  const terminal = page.getByTestId("inventory-terminal");
  await terminal.locator(".xterm").click();
  await page.keyboard.type(line);
  await page.keyboard.press("Enter");
}
test("only Terminal and Database; real SQLite shell write reaches inventory CLI", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto("/demos/cli/");
  await expect(page.getByRole("status")).toContainText(
    "reload restores the seed",
  );
  await expect(page.locator("h2")).toHaveText(["Terminal", "Database"]);
  expect(page.workers()).toHaveLength(1);
  await command(
    page,
    `echo '{"sku":"pipe","name":"Piped stock","quantity":7}' | inventory add --json | jq -r '"added=" + .sku'`,
  );
  await expect(page.getByTestId("inventory-terminal").locator(".xterm-rows"))
    .toContainText("added=pipe");
  await command(page, "inventory list | jq -r '.[].sku'");
  await expect(page.getByTestId("inventory-terminal").locator(".xterm-rows"))
    .toContainText("boltpipe");
  const db = page.getByTestId("db-console");
  await db.locator(".xterm").click();
  await page.keyboard.type(
    "INSERT INTO inventory VALUES ('shell', 'SQLite shell stock', 19);",
  );
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("db-last-change")).toContainText("from shell");
  await command(
    page,
    `inventory list | jq -r '.[] | select(.sku == "shell") | "quantity=" + (.quantity | tostring)'`,
  );
  await expect(page.getByTestId("inventory-terminal").locator(".xterm-rows"))
    .toContainText("quantity=19");
  await command(page, "inventory remove shell");
  await expect(page.getByTestId("inventory-terminal").locator(".xterm-rows"))
    .toContainText('{"removed":"shell"}');
  await command(
    page,
    `inventory list | jq -r '"remaining=" + (length | tostring)'`,
  );
  await expect(page.getByTestId("inventory-terminal").locator(".xterm-rows"))
    .toContainText("remaining=2");
  await page.getByTestId("db-tables").getByRole("button", {
    name: "inventory",
    exact: true,
  }).click();
  await expect(page.getByTestId("db-preview")).toContainText("Piped stock");
  await writeFile(
    `${evidence}/browser-terminal.txt`,
    await page.getByTestId("inventory-terminal").locator(".xterm-rows")
      .innerText(),
  );
  await writeFile(
    `${evidence}/browser-sqlite-shell.txt`,
    await db.locator(".xterm-rows").innerText(),
  );
  await page.screenshot({ path: `${evidence}/desktop.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() =>
    page.locator(".xterm-screen").evaluateAll((screens) =>
      screens.every((screen) =>
        screen.getBoundingClientRect().right <= innerWidth
      )
    )
  ).toBe(true);
  await page.screenshot({ path: `${evidence}/mobile.png`, fullPage: true });
  expect(
    await page.evaluate(() =>
      document.documentElement.scrollWidth <= innerWidth
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
  await page.evaluate(() => {
    (window as Window & { __r10Unmount?: () => void }).__r10Unmount?.();
  });
  await expect.poll(() => page.workers().length).toBe(0);
});
