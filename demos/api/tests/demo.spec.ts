import { expect, type Page, test } from "@playwright/test";
import process from "node:process";

async function send(
  page: Page,
  method: string,
  path = "/bookmarks",
  body = "",
) {
  const before = await page.getByTestId("calls").innerText();
  await page.getByLabel("Method", { exact: true }).selectOption(method);
  await page.getByLabel("Path", { exact: true }).fill(path);
  if (method === "POST") await page.getByLabel("JSON body").fill(body);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByTestId("calls")).not.toHaveText(before);
  return {
    status: Number(
      (await page.getByTestId("response-status").innerText()).split(" ")[0],
    ),
    body: JSON.parse(await page.getByTestId("response-body").innerText()),
  };
}

test.beforeEach(async ({ page }) => {
  await page.goto("/demos/api/");
  await expect(page.getByRole("button", { name: "Send", exact: true }))
    .toBeEnabled({ timeout: 45_000 });
});

test("only API and Database views", async ({ page }) => {
  await expect(
    page.getByRole("navigation", { name: "Views" }).getByRole("button"),
  ).toHaveText(["API", "Database"]);
  await expect(page.getByRole("region", { name: "API explorer" }))
    .toBeVisible();
  await page.getByRole("button", { name: "Database", exact: true }).click();
  await expect(page.getByTestId("db-console").locator(".xterm")).toBeVisible();
  await expect(page.getByRole("region", { name: "API explorer" })).toBeHidden();
});

test("view cycles keep one worker and unmount releases it", async ({ page }) => {
  await expect.poll(() => page.workers().length).toBe(1);
  for (let cycle = 0; cycle < 6; cycle++) {
    await page.getByRole("button", { name: "Database", exact: true }).click();
    await expect(page.getByTestId("db-console").locator(".xterm"))
      .toBeVisible();
    await page.getByRole("button", { name: "API", exact: true }).click();
    await expect(page.getByRole("region", { name: "API explorer" }))
      .toBeVisible();
    expect(page.workers(), `worker count after view cycle ${cycle + 1}`)
      .toHaveLength(1);
  }
  await page.goto("about:blank");
  await expect.poll(() => page.workers().length, { timeout: 10_000 }).toBe(0);
});

test("GET through explorer reads SQLite seed", async ({ page }) => {
  const result = await send(page, "GET");
  expect(result).toEqual({
    status: 200,
    body: [
      {
        id: 1,
        title: "SQLite documentation",
        url: "https://sqlite.org/docs.html",
      },
      { id: 2, title: "Deno documentation", url: "https://docs.deno.com/" },
    ],
  });
});

test("POST through explorer persists a bookmark", async ({ page }) => {
  const network: string[] = [];
  page.on("request", (r) => {
    if (r.url().startsWith("https://api.invalid")) network.push(r.url());
  });
  const created = await send(
    page,
    "POST",
    "/bookmarks",
    JSON.stringify({
      title: "  Reader's guide  ",
      url: "https://example.com/guide",
    }),
  );
  expect(created).toEqual({
    status: 201,
    body: { id: 3, title: "Reader's guide", url: "https://example.com/guide" },
  });
  await expect(page.getByTestId("response-headers")).toContainText(
    "location: /bookmarks/3",
  );
  expect((await send(page, "GET")).body).toContainEqual(created.body);
  await page.getByRole("button", { name: "Database", exact: true }).click();
  await expect(page.getByTestId("db-preview")).toContainText("Reader's guide");
  expect(network).toEqual([]);
});

test("DELETE through explorer removes a bookmark", async ({ page }) => {
  expect(await send(page, "DELETE", "/bookmarks/1")).toEqual({
    status: 200,
    body: {
      id: 1,
      title: "SQLite documentation",
      url: "https://sqlite.org/docs.html",
    },
  });
  expect((await send(page, "GET")).body.map((b: { id: number }) => b.id))
    .toEqual([2]);
  expect((await send(page, "DELETE", "/bookmarks/1")).status).toBe(404);
});

test("invalid request preset shows 400 and writes nothing", async ({ page }) => {
  await page.getByRole("button", { name: "Invalid request", exact: true })
    .click();
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByTestId("response-status")).toHaveText(
    "400 Bad Request",
  );
  expect(JSON.parse(await page.getByTestId("response-body").innerText()))
    .toEqual({
      error: {
        code: "InvalidInput",
        message: "url must be an http or https URL",
      },
    });
  await page.screenshot({
    path: `${process.env.PW_OUT ?? "test-results-r11"}/invalid.png`,
    fullPage: true,
  });
  expect((await send(page, "GET")).body).toHaveLength(2);
  expect((await send(page, "POST", "/bookmarks", "{broken")).status).toBe(400);
});

test("shell changes appear in subsequent GET", async ({ page }) => {
  await send(page, "GET");
  await page.getByRole("button", { name: "Database", exact: true }).click();
  const terminal = page.getByTestId("db-console").locator("textarea");
  await terminal.focus();
  await page.keyboard.insertText(
    "INSERT INTO bookmarks(title, url) VALUES ('From shell', 'https://example.com/shell');",
  );
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("db-last-change")).toContainText(
    "write from shell",
  );
  await expect(page.getByTestId("db-preview")).toContainText("From shell");
  await page.screenshot({
    path: `${process.env.PW_OUT ?? "test-results-r11"}/database.png`,
    fullPage: true,
  });
  await page.getByRole("button", { name: "API", exact: true }).click();
  const got = await send(page, "GET");
  expect(got.status).toBe(200);
  expect(got.body).toContainEqual({
    id: 3,
    title: "From shell",
    url: "https://example.com/shell",
  });
  await page.screenshot({
    path: `${process.env.PW_OUT ?? "test-results-r11"}/shell-get.png`,
    fullPage: true,
  });
});

test("narrow layout stays within viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await send(page, "GET");
  expect(
    await page.evaluate(() =>
      document.documentElement.scrollWidth <= innerWidth
    ),
  ).toBe(true);
  await page.screenshot({
    path: `${process.env.PW_OUT ?? "test-results-r11"}/narrow-api.png`,
    fullPage: true,
  });
  await page.getByRole("button", { name: "Database", exact: true }).click();
  await expect(page.getByTestId("db-console").locator(".xterm")).toBeVisible();
  expect(
    await page.evaluate(() =>
      document.documentElement.scrollWidth <= innerWidth
    ),
  ).toBe(true);
  await page.screenshot({
    path: `${process.env.PW_OUT ?? "test-results-r11"}/narrow-database.png`,
    fullPage: true,
  });
});
