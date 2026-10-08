// DB0: the real upstream sqlite3 shell (Fiddle 3.54.0) inside the common
// DatabaseEditor host, driven by keystrokes. Plan.md Q12 command coverage,
// multiline input, ";" inside strings, error-then-valid, the `.open` block,
// unsupported commands, history, and shell settings surviving a tab change
// (unmount/remount of the host without restarting the engine). The real
// terminal buffer is saved under db0-evidence/ for the run record.
import { expect, test } from "@playwright/test";
import {
  after,
  collectProblems,
  CONTINUATION_PROMPT,
  idle,
  MAIN_PROMPT,
  openEditor,
  saveEvidence,
  screen,
  screenshot,
  target,
  typeLine,
} from "./helpers.ts";

test.describe.configure({ mode: "serial" });

test("real prompt, Q12 commands and SQL with recorded upstream output", async ({ page }) => {
  const problems = collectProblems(page);
  await openEditor(page);

  // Fiddle's fiddle_main prints no banner (stdin is not interactive); the
  // first thing on screen is the shell's own prompt from fiddle_get_prompt().
  expect((await screen(page)).trim()).toBe(MAIN_PROMPT.trim());

  await typeLine(page, ".help");
  let text = await screen(page);
  const help = after(text, ".help\n");
  expect(help).toContain(".help ?-all? ?PATTERN?");
  expect(help).toContain(".mode ?MODE? ?OPTIONS?");
  expect(help).toContain(".tables ?TABLE?");
  expect(help).toContain(".schema ?PATTERN?");
  expect(help).not.toContain(".save FILE"); // compiled out of the Fiddle build
  const commands = help.split("\n").filter((l) => /^\.[a-z]/.test(l));
  expect(commands.length).toBe(47); // pocs/sqlite-shell/README.md
  // The shell echoes dot commands itself; the console shows them once.
  expect(text.match(/^SQLite-3\.54 fiddle\.sqlite3-> \.help$/gm)?.length).toBe(
    1,
  );
  expect(text).not.toMatch(/\n\.help\n/);
  saveEvidence(`01-help-${target}.txt`, text);

  await typeLine(page, ".tables");
  text = await screen(page);
  expect(after(text, ".tables\n")).toMatch(/^notes\s+tasks\n/);

  await typeLine(page, ".schema");
  text = await screen(page);
  expect(after(text, ".schema\n")).toContain("CREATE TABLE tasks(");
  expect(after(text, ".schema\n")).toContain("CREATE TABLE notes(");

  await typeLine(page, ".mode table");
  await typeLine(page, ".headers on");
  await typeLine(page, "SELECT id, title, done FROM tasks;");
  text = await screen(page);
  const table = after(text, "SELECT id, title, done FROM tasks;\n");
  expect(table).toMatch(
    /^\+----\+-------------\+------\+\n\| id \| {4}title {4}\| done \|\n\+----\+-------------\+------\+\n/,
  );
  expect(table).toContain("|  1 | Build API   |    0 |");

  await typeLine(page, ".mode csv");
  await typeLine(page, "SELECT id, title, done FROM tasks;");
  text = await screen(page);
  const csv = after(text, "SELECT id, title, done FROM tasks;\n");
  expect(csv).toMatch(
    /^id,title,done\n1,"Build API",0\n2,"Write tests",1\n3,"Ship v1",0\n/,
  );

  await typeLine(page, ".mode json");
  await typeLine(page, "SELECT id, title FROM tasks WHERE id < 3;");
  text = await screen(page);
  const json = after(text, "SELECT id, title FROM tasks WHERE id < 3;\n");
  expect(json).toMatch(
    /^\[\{"id":1,"title":"Build API"\},\n\{"id":2,"title":"Write tests"\}\]\n/,
  );

  await typeLine(page, ".headers off");
  await typeLine(page, ".mode list");
  await typeLine(
    page,
    "SELECT big, body, quote(payload) FROM notes ORDER BY id;",
  );
  text = await screen(page);
  expect(after(text, "FROM notes ORDER BY id;\n")).toMatch(
    /^9007199254740993\|semi;colon\|X'00FF10'\n\|\|NULL\n/,
  );
  saveEvidence(`02-q12-commands-${target}.txt`, text);
  await screenshot(page, "shell-q12");
  expect(problems).toEqual([]);
});

test("multiline input, ';' inside strings, error then valid, .open blocked, unsupported, history", async ({ page }) => {
  const problems = collectProblems(page);
  await openEditor(page);
  await typeLine(page, ".mode list");

  // Multiline: the first line is incomplete, so the host shows the fixed
  // continuation prompt and submits the whole unit once sqlite3_complete
  // accepts it (the shell then runs it as one input).
  await page.keyboard.type("SELECT title");
  await page.keyboard.press("Enter");
  await idle(page);
  let text = await screen(page);
  expect(text).toMatch(/SELECT title\n {3}\.\.\.> $/);
  await typeLine(page, "FROM tasks");
  await typeLine(page, "WHERE id = 2;");
  text = await screen(page);
  expect(after(text, "WHERE id = 2;\n")).toMatch(/^Write tests\n/);
  expect(text).toContain(
    `${CONTINUATION_PROMPT}FROM tasks\n${CONTINUATION_PROMPT}WHERE id = 2;`,
  );

  // ";" inside a string on one line and across lines.
  await typeLine(page, "INSERT INTO notes(body) VALUES ('a;b');");
  await typeLine(page, "SELECT body FROM notes WHERE body = 'a;b';");
  text = await screen(page);
  expect(after(text, "WHERE body = 'a;b';\n")).toMatch(/^a;b\n/);
  await typeLine(page, "SELECT 'x;");
  text = await screen(page);
  expect(text).toMatch(/SELECT 'x;\n {3}\.\.\.> $/);
  await typeLine(page, "y';");
  text = await screen(page);
  // The literal is x;<newline>y (the closing quote is not part of it).
  expect(after(text, `${CONTINUATION_PROMPT}y';\n`)).toMatch(/^x;\ny\n/);

  // Error, then a valid statement (no -bail: the shell keeps going).
  await typeLine(page, "SELEC 1;");
  text = await screen(page);
  expect(after(text, "SELEC 1;\n")).toMatch(
    /^Parse error near line 1: near "SELEC": syntax error\n {2}SELEC 1;\n {2}\^--- error here\n/,
  );
  await typeLine(page, "SELECT 1 + 1;");
  text = await screen(page);
  expect(after(text, "SELECT 1 + 1;\n")).toMatch(/^2\n/);
  await typeLine(page, "SELECT * FROM nope;");
  text = await screen(page);
  expect(after(text, "SELECT * FROM nope;\n")).toMatch(
    /^Parse error near line 1: no such table: nope/,
  );

  // `.open` (and upstream's prefix abbreviations, n >= 2) and `.connection`
  // (any prefix) are refused with a visible message; the live database is
  // still attached afterwards, for the shell and for the app.
  const BLOCKED = (cmd: string) =>
    new RegExp(
      `^Error: "\\.${cmd}" is disabled in this console\\.\\nThe prototype's live database stays attached; use the host's Reset or Import controls instead\\.\\n`,
    );
  const countTasks = () =>
    page.evaluate(() =>
      globalThis.window.__db0!.execute("SELECT count(*) FROM tasks").then((
        r,
      ) => r.rows[0][0])
    );
  for (
    const [typed, cmd] of [
      [".open :memory:", "open"],
      [".op :memory:", "open"],
      [".ope :memory:", "open"],
      [".connection 1", "connection"],
      [".c 1", "connection"],
      [".con", "connection"],
    ] as const
  ) {
    await typeLine(page, typed);
    text = await screen(page);
    expect(after(text, `${typed}\n`), typed).toMatch(BLOCKED(cmd));
    expect(await countTasks(), typed).toBe(3);
  }
  // Spellings upstream parseDotCmdArgs() accepts: quoted first token, space
  // or tab after the dot, trailing ";". Sent through the submit API because
  // the console drops a typed tab.
  for (
    const [unit, cmd] of [
      ['."open" :memory:', "open"],
      [".'op' :memory:", "open"],
      ['."c" 1', "connection"],
      [". open :memory:", "open"],
      [".\topen :memory:", "open"],
      [".open;", "open"],
      [".op;", "open"],
      ['."\\x6fpen" :memory:', "open"],
      [".co 1 ;  ", "connection"],
      // Resolved or raw NUL ends the C string upstream, not the token.
      ['."op\\x" :memory:', "open"],
      ['."op\\0" :memory:', "open"],
      ['."op\\x00" :memory:', "open"],
      ['."c\\x" 1', "connection"],
      [".open\u0000junk :memory:", "open"],
    ] as const
  ) {
    await page.evaluate((u) => globalThis.window.__db0!.submit(u), unit);
    await idle(page);
    text = await screen(page);
    const tail = text.split("\n").slice(-3).join("\n") + "\n";
    expect(tail, unit).toMatch(BLOCKED(cmd));
    expect(await countTasks(), unit).toBe(3);
  }
  await typeLine(page, ".tables");
  text = await screen(page);
  expect(after(text, ".tables\n")).toMatch(/^notes\s+tasks\n/);
  // Through the submit API a unit can carry several lines; a blocked line
  // anywhere refuses the whole unit (process_input would run it once the SQL
  // before it has finished), so neither the SQL nor the command runs.
  for (
    const [unit, cmd] of [
      [".tables\n.open :memory:", "open"],
      ["SELECT 1;\n.open :memory:\nSELECT 2;", "open"],
      [".c 1\nSELECT 1;", "connection"],
    ] as const
  ) {
    await page.evaluate((u) => globalThis.window.__db0!.submit(u), unit);
    await idle(page);
    text = await screen(page);
    const tail = text.split("\n").slice(-3).join("\n") + "\n";
    expect(tail, unit).toMatch(BLOCKED(cmd));
    expect(text).not.toMatch(/\n[12]\nSQLite-3\.54 fiddle\.sqlite3-> $/); // no SELECT ran
    expect(await countTasks(), unit).toBe(3);
  }
  await typeLine(page, ".tables");
  text = await screen(page);
  expect(after(text, ".tables\n")).toMatch(/^notes\s+tasks\n/);

  // Commands compiled out of the Fiddle build answer with the shell's own text.
  await typeLine(page, ".quit");
  await typeLine(page, ".save x.db");
  text = await screen(page);
  expect(after(text, ".quit\n")).toMatch(
    /^Error: unknown command or invalid arguments: {2}"quit"\. Enter "\.help" for help\n/,
  );
  expect(after(text, ".save x.db\n")).toMatch(
    /^Error: unknown command or invalid arguments: {2}"save"\. Enter "\.help" for help\n/,
  );

  // History: Up recalls the previous line; Enter runs it again.
  await typeLine(page, "SELECT count(*) FROM tasks;");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  await idle(page);
  text = await screen(page);
  expect(text.match(/SELECT count\(\*\) FROM tasks;\n3\n/g)?.length).toBe(2);
  saveEvidence(`03-input-edge-cases-${target}.txt`, text);
  await screenshot(page, "shell-edge-cases");
  expect(problems).toEqual([]);
});

test("shell settings survive hiding and re-showing the database view", async ({ page }) => {
  const problems = collectProblems(page);
  await openEditor(page);
  await typeLine(page, ".mode json");
  await typeLine(page, "SELECT id FROM tasks WHERE id = 1;");
  expect(after(await screen(page), "WHERE id = 1;\n")).toMatch(
    /^\[\{"id":1\}\]\n/,
  );

  const workersBefore = page.workers().length;
  await page.getByTestId("db0-toggle").click(); // unmounts the host
  await expect(page.getByTestId("db-editor")).toHaveCount(0);
  expect(await page.evaluate(() => globalThis.window.__db0!.binding.terminal))
    .toBeUndefined();
  await page.getByTestId("db0-toggle").click(); // remounts; engine untouched
  await expect(page.getByTestId("db-console").locator(".xterm")).toBeVisible();
  await expect.poll(() => screen(page)).toContain(MAIN_PROMPT);
  expect(page.workers().length).toBe(workersBefore);
  await page.getByTestId("db-console").locator(".xterm").click();
  await typeLine(page, "SELECT id FROM tasks WHERE id = 2;");
  const text = await screen(page);
  expect(after(text, "WHERE id = 2;\n")).toMatch(/^\[\{"id":2\}\]\n/); // still .mode json
  // History carried over as well.
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  expect(await screen(page)).toMatch(/SELECT id FROM tasks WHERE id = 1;$/);
  await page.keyboard.press("Enter");
  await idle(page);
  expect(after(await screen(page), "WHERE id = 1;\n")).toMatch(
    /^\[\{"id":1\}\]\n/,
  );
  saveEvidence(`04-tab-change-${target}.txt`, await screen(page));

  // Narrow viewport: the host panel wraps under the console (visual check).
  await page.setViewportSize({ width: 900, height: 900 });
  await screenshot(page, "shell-narrow");
  expect(problems).toEqual([]);
});

test("a submit interrupted by hiding the view still settles", async ({ page }) => {
  const problems = collectProblems(page);
  await openEditor(page);
  await typeLine(page, ".mode list");
  // Start a slow statement, hide the view while it runs, then await it.
  await page.evaluate(() => {
    const w = globalThis.window as unknown as {
      __db0Pending?: Promise<string>;
    };
    w.__db0Pending = globalThis.window.__db0!.submit(
      "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2000000) SELECT count(*) FROM n;",
    ).then(() => "settled");
  });
  await page.getByTestId("db0-toggle").click(); // unmounts the console mid-submission
  await expect(page.getByTestId("db-editor")).toHaveCount(0);
  const settled = await page.evaluate(() =>
    (globalThis.window as unknown as { __db0Pending: Promise<string> })
      .__db0Pending
  );
  expect(settled).toBe("settled");
  // The engine kept going and the binding is still usable after remount.
  await page.getByTestId("db0-toggle").click();
  await expect(page.getByTestId("db-console").locator(".xterm")).toBeVisible();
  await page.getByTestId("db-console").locator(".xterm").click();
  await typeLine(page, "SELECT 7;");
  expect(after(await screen(page), "SELECT 7;\n")).toMatch(/^7\n/);
  expect(problems).toEqual([]);
});
