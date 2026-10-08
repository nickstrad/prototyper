// DB1: the pinned upstream DuckDB web shell runs the Q12 DuckDB command set
// and SQL in DB0's DatabaseEditor host on D2's live instance; `.open` is
// refused; nothing DuckDB-related loads before the view is opened.
import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import {
  after,
  collectProblems,
  db1,
  focusShell,
  loadPlayground,
  OPEN_REFUSAL,
  openDuckDb,
  openInstance,
  outputOf,
  PROMPT,
  saveEvidence,
  screen,
  screenshot,
  target,
  typeLine,
} from "./helpers.ts";

test.describe.configure({ timeout: 120_000 });

/** Requests that only a DuckDB view may cause (engine, shell, Arrow). */
const DUCKDB_ASSET =
  /shell_bg|duckdb-eh|duckdb-browser|duckdb-wasm|duckdb_duckdb|vendor\/duckdb/;

test("nothing DuckDB loads before the view opens; the shell wasm comes from this origin", async ({ page }) => {
  const problems = collectProblems(page);
  const requests: string[] = [];
  page.on("request", (r) => requests.push(r.url()));
  await loadPlayground(page);
  // Not "networkidle": the dev server's and other panels' traffic may never
  // go quiet. A settled page load plus a few seconds of normal use.
  await page.waitForLoadState("load");
  await page.waitForTimeout(3000);
  expect(requests.filter((u) => DUCKDB_ASSET.test(u))).toEqual([]);
  await expect(page.getByTestId("db1-status")).toHaveText("DuckDB not loaded");

  // The binary itself (in dev, `shell_bg.wasm?import&url` is a JS module).
  const wasm = page.waitForResponse((r) => {
    const path = new URL(r.url()).pathname;
    return path.includes("shell_bg") && path.endsWith(".wasm") &&
      !r.url().includes("?import");
  });
  await openInstance(page);
  const response = await wasm;
  const origin = new URL(page.url()).origin;
  expect(new URL(response.url()).origin).toBe(origin);
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("application/wasm");
  if (target === "static") {
    expect(new URL(response.url()).pathname).toMatch(
      /^\/assets\/shell_bg-[\w-]+\.wasm$/,
    );
  }
  const loaded = requests.filter((u) => DUCKDB_ASSET.test(u));
  expect(loaded.every((u) => new URL(u).origin === origin)).toBe(true);
  saveEvidence(
    `00-assets-${target}.txt`,
    `shell wasm: ${response.url()} (${
      response.headers()["content-type"]
    })\nrequests after open:\n${loaded.join("\n")}\n`,
  );
  expect(problems).toEqual([]);
});

test(".help matches the pinned shell's recorded .help", async ({ page }) => {
  const problems = collectProblems(page);
  await openDuckDb(page);
  const banner = await screen(page);
  expect(banner).toContain("DuckDB Web Shell");
  expect(banner).toContain("Database: v1.4.3");
  expect(banner).toContain("Package:  @duckdb/duckdb-wasm@1.32.0");

  await typeLine(page, ".help");
  const help = outputOf(await screen(page), ".help");
  // pocs/duckdb-shell/evidence/01-help.txt: the POC's output section.
  const recorded = readFileSync(
    "pocs/duckdb-shell/evidence/01-help.txt",
    "utf8",
  );
  const pocOutput = recorded.slice(
    recorded.indexOf(`${PROMPT}.help\n`) + `${PROMPT}.help\n`.length,
  ).replace(/\nduckdb> \s*$/, "");
  expect(help).toBe(pocOutput);
  for (
    const command of [
      ".clear",
      ".examples",
      ".features",
      ".files list",
      ".open $FILE",
      ".reset",
      ".timer on|off",
      ".output on|off",
    ]
  ) expect(help).toContain(command);
  // ShellBinding.output carries the shell's own writes, ANSI styling intact.
  const streamed = await db1(page, (h) => h.output.join(""), null);
  expect(streamed).toContain("\u001b[1mduckdb\u001b[m> ");
  expect(streamed).toContain(
    ".timer on|off          Turn query timer on or off.",
  );
  saveEvidence(
    `01-help-${target}.txt`,
    `# input:\n#   .help\n# output (pinned @duckdb/duckdb-wasm-shell@1.32.0):\n${PROMPT}.help\n${help}\n`,
  );
  expect(problems).toEqual([]);
});

test("Q12 DuckDB command set and SQL walkthrough run in the upstream shell", async ({ page }) => {
  const problems = collectProblems(page);
  await openDuckDb(page);
  const transcript: string[] = [];
  const run = async (line: string) => {
    await typeLine(page, line);
    const out = outputOf(await screen(page), line);
    transcript.push(`${PROMPT}${line}\n${out}`);
    return out;
  };

  // SQL equivalents for the commands the web shell lacks (Q12).
  const show = await run("SHOW TABLES;");
  expect(show).toContain("│ name  │");
  expect(show).toContain("│ tasks │");
  const describe = await run("DESCRIBE tasks;");
  for (const column of ["id", "title", "completed", "created_at"]) {
    expect(describe).toMatch(new RegExp(`│ ${column}\\s+┆`));
  }
  expect(describe).toContain("column_type");
  const select = await run(
    "SELECT id, title, completed FROM tasks ORDER BY id;",
  );
  expect(select).toContain("Write the project plan");
  expect(select).toContain("Wire the terminal");

  // The shell's own commands from its .help list.
  const features = await run(".features");
  expect(features.length).toBeGreaterThan(0);
  expect(features).not.toContain("Unknown command");
  const examples = await run(".examples");
  expect(examples).not.toContain("Unknown command");
  expect(await run(".timer on")).toContain("Timer enabled");
  expect(await run("SELECT 42 AS answer;")).toMatch(/Elapsed: \d+ ms/);
  expect(await run(".timer off")).toContain("Timer disabled");
  expect(await run("SELECT 43 AS answer;")).not.toContain("Elapsed");
  await run(".output off");
  expect(await run("SELECT 'hidden' AS x;")).not.toContain("hidden │");
  await run(".output on");
  expect(await run("SELECT 'shown' AS x;")).toContain("shown");
  expect(await run(".files")).not.toContain("Unknown command");
  expect(await run(".files list")).not.toContain("Unknown command");

  // Commands the pinned shell does not have: its own response, untouched.
  expect(await run(".tables")).toBe("Unknown command: .tables\n");
  expect(await run(".schema")).toBe("Unknown command: .schema\n");
  expect(await run(".mode csv")).toBe("Unknown command: .mode\n");
  expect(await run(".headers on")).toBe("Unknown command: .headers\n");
  expect(await run(".reset")).toContain("Not implemented yet");

  // Multiline input (the shell's own continuation prompt), ';' in a string,
  // an error followed by a valid statement.
  await typeLine(page, "SELECT count(*) AS n");
  await typeLine(page, "FROM tasks");
  await typeLine(page, "WHERE completed = 0;");
  const multi = await screen(page);
  expect(multi).toContain(
    `${PROMPT}SELECT count(*) AS n\n   ...> FROM tasks\n   ...> WHERE completed = 0;\n`,
  );
  expect(after(multi, "WHERE completed = 0;\n")).toMatch(/│\s+2 │/);
  transcript.push(
    multi.slice(multi.lastIndexOf(`${PROMPT}SELECT count(*) AS n\n`))
      .replace(/\nduckdb> $/, ""),
  );
  expect(await run("SELECT 'a;b' AS s, length('x;y;z') AS n;")).toMatch(
    /│ a;b ┆ 5 │/,
  );
  expect(await run("SELEC 1;")).toContain(
    'Parser Error: syntax error at or near "SELEC"',
  );
  expect(await run("SELECT 'valid after error' AS ok;")).toContain(
    "valid after error",
  );

  // .clear clears the shell's screen (last: it wipes the transcript).
  saveEvidence(`02-commands-${target}.txt`, transcript.join("\n") + "\n");
  await screenshot(page, "02-commands");
  await typeLine(page, ".clear");
  expect(await screen(page)).not.toContain("valid after error");
  expect(await screen(page)).toMatch(/duckdb> $/);
  expect(problems).toEqual([]);
});

test(".open is refused with a visible message and the app's tables stay intact", async ({ page }) => {
  const problems = collectProblems(page);
  await openDuckDb(page);
  const before = await db1(page, (h) => h.tables(), null);
  expect(before).toContain("tasks");
  const transcript: string[] = [];
  for (const line of [".open", ".open :memory:", ".open other.duckdb"]) {
    await typeLine(page, line);
    // The app's tables, data and connection are untouched.
    expect(await db1(page, (h) => h.tables(), null)).toEqual(before);
    const count = await db1(
      page,
      (h) => h.execute("SELECT count(*) AS n FROM tasks"),
      null,
    );
    expect(count.rows).toEqual([[3]]);
    const dbs = await db1(
      page,
      (h) =>
        h.execute(
          "SELECT count(*) AS n FROM duckdb_databases() WHERE NOT internal",
        ),
      null,
    );
    expect(dbs.rows).toEqual([[1]]);
    const text = await screen(page);
    const out = after(text, `${PROMPT}${line}\n`);
    expect(out.startsWith(`${OPEN_REFUSAL}\n`)).toBe(true);
    transcript.push(`${PROMPT}${line}\n${out}`);
    // The shell is still attached to the same instance and takes input.
    await focusShell(page);
    await typeLine(page, "SELECT count(*) AS n FROM tasks;");
    expect(outputOf(await screen(page), "SELECT count(*) AS n FROM tasks;"))
      .toMatch(/│\s+3 │/);
  }
  // A shell write after the refusal is visible to the app (same instance).
  await typeLine(
    page,
    "INSERT INTO tasks (title, created_at) VALUES ('after .open', 'now');",
  );
  const rows = await db1(
    page,
    (h) => h.execute("SELECT title FROM tasks WHERE title = 'after .open'"),
    null,
  );
  expect(rows.rows).toEqual([["after .open"]]);
  saveEvidence(`03-open-blocked-${target}.txt`, transcript.join("\n"));
  await screenshot(page, "03-open-blocked");
  expect(problems).toEqual([]);
});
