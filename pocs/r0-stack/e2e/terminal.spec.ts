import { expect, type Page, test } from "@playwright/test";
import process from "node:process";

const terminalText = (page: Page) =>
  page.evaluate(() => {
    const buf = globalThis.window.__term!.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buf.length; i++) {
      lines.push(buf.getLine(i)?.translateToString(true) ?? "");
    }
    return lines.join("\n");
  });

async function run(page: Page, cmd: string) {
  await page.keyboard.type(cmd);
  await page.keyboard.press("Enter");
}

test("terminal runs just-bash + Effect commands", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") {
      consoleErrors.push(m.text());
    }
  });
  page.on("pageerror", (e) => consoleErrors.push(String(e)));

  await page.goto("/");
  await expect(page.locator(".xterm-rows")).toContainText("$");
  await page.locator(".xterm").click();

  await run(page, "hello Alice");
  await run(page, 'tasks create "Build API"');
  await run(page, "tasks create 'Write tests'");
  await run(page, "tasks list --json | jq '.[].title'");
  await run(page, "echo a | tr a-z A-Z");
  await run(page, "tasks complete 42");
  await run(page, "sqlite3 :memory: 'select 1'");
  // History: Up arrow recalls the previous command line.
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");

  await expect.poll(async () =>
    (await terminalText(page)).match(/task 42 not found/g)?.length
  )
    .toBe(2);
  await run(page, 'tasks create ""');
  await expect.poll(() => terminalText(page)).toContain(
    "invalid input: title is required",
  );
  const text = await terminalText(page);
  expect(text).toContain("Hello, Alice!");
  expect(text).toContain("created 1: Build API");
  expect(text).toContain('"Build API"\n"Write tests"');
  expect(text).toMatch(/tr a-z A-Z\nA\n/);
  expect(text).toContain("tasks: task 42 not found\n[exit 1]");
  // The repeated history command must reproduce stderr + exit again.
  expect(text.match(/task 42 not found/g)?.length).toBe(2);
  // Bundled sqlite3 is not available in the browser build.
  expect(text).toContain(
    "sqlite3: command not available in browser environments",
  );
  expect(text).toContain("[exit 127]");

  await page.screenshot({
    path: `evidence/terminal-${process.env.PW_TARGET ?? "dev"}.png`,
  });
  console.log("---- terminal buffer ----\n" + text.trimEnd());
  console.log("---- console warnings/errors ----\n" + consoleErrors.join("\n"));
});
