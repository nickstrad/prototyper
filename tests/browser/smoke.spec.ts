// R0 smoke suite. Runs against the Vite dev server by default and against the
// production build served by a plain static file server with PW_TARGET=static.
import { expect, type Page, test } from "@playwright/test";
import process from "node:process";

const target = process.env.PW_TARGET ?? "dev";

const terminalText = (page: Page) =>
  page.evaluate(() => {
    const buf = globalThis.window.__playground!.term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buf.length; i++) {
      lines.push(buf.getLine(i)?.translateToString(true) ?? "");
    }
    return lines.join("\n");
  });

async function run(page: Page, cmd: string) {
  await page.keyboard.type(cmd);
  await page.keyboard.press("Enter");
  await page.evaluate(() => globalThis.window.__playground!.session.idle());
}

function collectProblems(page: Page) {
  const problems: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") problems.push(m.text());
  });
  page.on("pageerror", (e) => problems.push(String(e)));
  return problems;
}

test("terminal: quoted args, jq pipeline, typed failure, history", async ({ page }) => {
  const problems = collectProblems(page);
  await page.goto("/");
  await expect(page.locator(".xterm-rows")).toContainText("$");
  await page.locator(".xterm").click();

  await run(page, "hello Alice");
  await run(page, 'tasks create "Build API"');
  await run(page, "tasks create 'Write tests'");
  await run(page, "tasks list --json | jq '.[].title'");
  await run(page, "echo a | tr a-z A-Z");
  await run(page, "tasks complete 42");
  await run(page, 'tasks create ""');
  await run(page, "sqlite3 :memory: 'select 1'");
  // History: two Up arrows recall `tasks create ""`... one more recalls the
  // failing complete; run it again so stderr + exit must render twice.
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  await page.evaluate(() => globalThis.window.__playground!.session.idle());

  const text = await terminalText(page);
  expect(text).toContain("Hello, Alice!");
  expect(text).toContain("created 1: Build API"); // quoted argument intact
  expect(text).toContain("created 2: Write tests");
  expect(text).toContain('"Build API"\n"Write tests"'); // | jq rendered
  expect(text).toMatch(/tr a-z A-Z\nA\n/);
  expect(text).toContain("tasks: task 42 not found\n[exit 1]"); // typed failure
  expect(text).toContain("invalid input: title is required\n[exit 1]");
  expect(text.match(/task 42 not found/g)?.length).toBe(2); // history replay
  // just-bash's bundled sqlite3 is not the database console (plan.md §5).
  expect(text).toContain(
    "sqlite3: command not available in browser environments",
  );
  expect(text).toContain("[exit 127]");

  await page.screenshot({ path: `test-results/playground-${target}.png` });
  console.log(`---- terminal buffer (${target}) ----\n` + text.trimEnd());
  expect(problems, "console errors/warnings and page errors").toEqual([]);
});

test("engine worker loads the vendored Fiddle module and answers both families", async ({ page }) => {
  const problems = collectProblems(page);
  await page.goto("/");

  const info = await page.evaluate(() =>
    globalThis.window.__playground!.engine.ready
  );
  expect(info.engine).toBe("sqlite");
  expect(info.libversion).toBe("3.54.0");
  expect(info.sourceId).toContain("4bfc6e53a9");
  expect(info.prompt).toContain("SQLite-3.54");
  expect(info.crossOriginIsolated).toBe(false); // plain static server, no COOP/COEP
  await expect(page.getByTestId("engine-status")).toContainText(
    "SQLite 3.54.0",
  );

  // The assets came from the vendored directory of THIS origin, not sqlite.org.
  const vendorDir = await page.evaluate(() =>
    globalThis.window.__playground!.engine.vendorDir
  );
  expect(vendorDir).toBe("/vendor/fiddle/");
  const wasm = await page.request.get("/vendor/fiddle/fiddle-module.wasm");
  expect(wasm.status()).toBe(200);
  expect(wasm.headers()["content-type"]).toContain("application/wasm");
  expect((await wasm.body()).byteLength).toBe(1_435_205);

  // exec family: stubbed in R0, must still answer with a protocol-shaped error.
  const execError = await page.evaluate(() =>
    globalThis.window.__playground!.engine.exec("select 1").then(
      () => null,
      (e: unknown) => e,
    )
  );
  expect(execError).toMatchObject({
    _tag: "DatabaseError",
    operation: "execute",
  });
  const tablesError = await page.evaluate(() =>
    globalThis.window.__playground!.engine.op("tables").then(
      () => null,
      (e: unknown) => e,
    )
  );
  expect(tablesError).toMatchObject({
    _tag: "DatabaseError",
    operation: "tables",
  });

  // shell family: stubbed in R0; emits stderr output and the real prompt.
  await page.evaluate(() =>
    globalThis.window.__playground!.engine.shell({
      family: "shell",
      op: "submit",
      text: ".tables\n",
    })
  );
  await expect
    .poll(() =>
      page.evaluate(() =>
        globalThis.window.__playground!.engineEvents.filter((e) =>
          e.family === "shell"
        )
      )
    )
    .toEqual(expect.arrayContaining([
      expect.objectContaining({
        family: "shell",
        op: "output",
        stream: "stderr",
        text: expect.stringContaining("not implemented in R0"),
      }),
      expect.objectContaining({
        family: "shell",
        op: "prompt",
        text: expect.stringContaining("SQLite-3.54"),
      }),
    ]));

  console.log(
    `---- engine info (${target}) ----\n` + JSON.stringify(info, null, 1),
  );
  expect(problems, "console errors/warnings and page errors").toEqual([]);
});
