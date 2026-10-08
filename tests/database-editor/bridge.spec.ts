// DB0: the console and the application share one live database. App writes
// (structured path on the shell's own sqlite3*) show up in shell SELECTs and
// shell writes show up in structured queries; change events, host controls
// (table list, schema, preview, reset, export/import), typed errors, cell
// types, and cleanup (worker gone after dispose) are verified here.
import { expect, test } from "@playwright/test";
import {
  after,
  collectProblems,
  idle,
  openEditor,
  saveEvidence,
  screen,
  screenshot,
  target,
  typeLine,
} from "./helpers.ts";

test.describe.configure({ mode: "serial" });

const execute = (page: import("@playwright/test").Page, sql: string) =>
  page.evaluate((s) => globalThis.window.__db0!.execute(s), sql);

const changes = (page: import("@playwright/test").Page) =>
  page.evaluate(() => globalThis.window.__db0!.changes.slice());

test("app write visible in the shell, shell write visible to the app, change events", async ({ page }) => {
  const problems = collectProblems(page);
  await openEditor(page);
  await typeLine(page, ".mode list");
  const before = await changes(page);
  expect(before.filter((c) => c.source === "shell")).toEqual([]);

  // App -> shell.
  const insert = await execute(
    page,
    "INSERT INTO tasks(title, done, created_at) VALUES ('from-app', 0, '2026-10-08T01:00:00Z')",
  );
  expect(insert.changes).toBe(1);
  expect(insert.schemaChanged).toBe(false);
  await typeLine(page, "SELECT id, title FROM tasks WHERE title = 'from-app';");
  let text = await screen(page);
  expect(after(text, "WHERE title = 'from-app';\n")).toMatch(/^4\|from-app\n/);

  // Shell -> app (DML and DDL).
  await typeLine(
    page,
    "INSERT INTO tasks(title, done, created_at) VALUES ('from-shell', 1, 'x');",
  );
  await typeLine(page, "CREATE TABLE extra(x INTEGER);");
  const seen = await execute(
    page,
    "SELECT id, title, done FROM tasks WHERE title = 'from-shell'",
  );
  expect(seen.columns).toEqual(["id", "title", "done"]);
  expect(seen.rows).toEqual([[5, "from-shell", 1]]);
  expect(await page.evaluate(() => globalThis.window.__db0!.tables())).toEqual([
    "extra",
    "notes",
    "tasks",
  ]);
  // The host's table list follows the shell's DDL through the change stream.
  await expect(page.getByTestId("db-tables")).toContainText("extra");

  // Exactly one event per write, attributed to its source.
  const now = (await changes(page)).slice(before.length);
  expect(now).toEqual([
    { kind: "write", source: "app", changes: 1, schemaChanged: false },
    { kind: "write", source: "shell", changes: 1, schemaChanged: false },
    { kind: "write", source: "shell", changes: 0, schemaChanged: true },
  ]);

  // No isolation: one connection. An uncommitted shell BEGIN is visible to
  // the app; after ROLLBACK the row is gone (pocs/sqlite-shell bridge test 7).
  await typeLine(page, "BEGIN;");
  await typeLine(
    page,
    "INSERT INTO tasks(title, done, created_at) VALUES ('uncommitted', 0, 'y');",
  );
  const dirty = await execute(
    page,
    "SELECT count(*) FROM tasks WHERE title = 'uncommitted'",
  );
  expect(dirty.rows).toEqual([[1]]);
  const inTx = (await changes(page)).length;
  await typeLine(page, "ROLLBACK;");
  const clean = await execute(
    page,
    "SELECT count(*) FROM tasks WHERE title = 'uncommitted'",
  );
  expect(clean.rows).toEqual([[0]]);
  // Conservative: the shell-write detector publishes once the transaction
  // ends (total_changes counts rolled-back rows); nothing while it is open.
  expect((await changes(page)).length).toBe(inTx + 1);

  // .mode json in the shell never affects app decoding.
  await typeLine(page, ".mode json");
  const typed = await execute(
    page,
    "SELECT big, body, payload FROM notes ORDER BY id",
  );
  expect(typed.rows).toEqual([
    [{ $type: "bigint", value: "9007199254740993" }, "semi;colon", {
      $type: "blob",
      base64: "AP8Q",
    }],
    [null, null, null],
  ]);
  await typeLine(page, "SELECT id FROM tasks WHERE id = 1;");
  text = await screen(page);
  expect(after(text, "WHERE id = 1;\n")).toMatch(/^\[\{"id":1\}\]\n/);

  // Typed errors from the structured path; never parsed from shell text.
  const error = await page.evaluate(() =>
    globalThis.window.__db0!.execute("SELECT * FROM nope").then(
      () => null,
      (e: unknown) => e,
    )
  );
  expect(error).toMatchObject({
    _tag: "DatabaseError",
    operation: "execute",
    message: "no such table: nope",
  });
  saveEvidence(`05-bridge-${target}.txt`, text);
  expect(problems).toEqual([]);
});

test("host controls: tables, schema, bounded preview, reset, export/import", async ({ page }) => {
  const problems = collectProblems(page);
  await openEditor(page);
  await typeLine(page, ".mode list");

  await expect(page.getByTestId("db-status")).toContainText(
    "sqlite 3.54.0 · persistence: memory",
  );
  await expect(page.getByTestId("db-tables")).toContainText("notes");
  await page.getByTestId("db-tables").getByRole("button", { name: "notes" })
    .click();
  await expect(page.getByTestId("db-schema")).toContainText(
    "CREATE TABLE notes(id INTEGER PRIMARY KEY, body TEXT, payload BLOB, big INTEGER)",
  );
  const preview = page.getByTestId("db-preview");
  await expect(preview).toContainText("9007199254740993"); // bigint intact
  await expect(preview).toContainText("blob(3 B)");
  await expect(preview).toContainText("NULL");
  await expect(preview).toContainText("semi;colon");

  // Bounded preview: more rows than the limit shows the truncation note.
  await page.evaluate(() =>
    globalThis.window.__db0!.execute(
      "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 80) INSERT INTO notes(body) SELECT 'row ' || i FROM n",
    )
  );
  await expect(page.getByText("first 50 shown; result truncated"))
    .toBeVisible();
  await expect(preview.locator("tbody tr")).toHaveCount(50);

  // Reset restores the seed and tells the shell's view as well.
  await page.getByTestId("db-reset").click();
  await expect(page.getByTestId("db-message")).toHaveText(
    "database reset to its seed",
  );
  await expect(preview.locator("tbody tr")).toHaveCount(2);
  expect((await execute(page, "SELECT count(*) FROM notes")).rows).toEqual([[
    2,
  ]]);
  await page.getByTestId("db-console").locator(".xterm").click();
  await typeLine(page, ".tables");
  expect(after(await screen(page), ".tables\n")).toMatch(/^notes\s+tasks\n/);
  await expect(page.getByTestId("db-last-change")).toContainText(
    "last change: reset from host",
  );

  // Export bytes are a real SQLite image; import replaces the live data
  // (same handle) and publishes an import change.
  const exported = await page.evaluate(async () => {
    const bytes = await globalThis.window.__db0!.exportBytes();
    return {
      length: bytes.length,
      header: new TextDecoder().decode(bytes.subarray(0, 15)),
    };
  });
  expect(exported.header).toBe("SQLite format 3");
  expect(exported.length).toBeGreaterThan(4096);
  const roundTrip = await page.evaluate(async () => {
    const hooks = globalThis.window.__db0!;
    const attempt = <A>(p: Promise<A>) =>
      p.then((value) => ({ value }), (error: unknown) => ({ error }));
    const count = () =>
      hooks.execute("SELECT count(*) FROM tasks").then((r) => r.rows[0][0]);
    const steps: string[] = [];
    try {
      steps.push("export");
      const image = await hooks.exportBytes();
      steps.push("delete");
      await hooks.execute("DELETE FROM tasks");
      steps.push("count");
      const emptied = await count();
      steps.push("import");
      const imported = await attempt(hooks.importBytes(image));
      steps.push("count");
      const restored = await count();
      steps.push("garbage");
      const garbage = await attempt(hooks.importBytes(new Uint8Array(1024)));
      const corrupted = image.slice();
      corrupted.fill(0xff, 100, 4000);
      steps.push("corrupt");
      const corrupt = await attempt(hooks.importBytes(corrupted));
      steps.push("count");
      const still = await count();
      return {
        failure: null,
        steps,
        emptied,
        imported,
        restored,
        garbage,
        corrupt,
        still,
        changes: hooks.changes.slice(-4),
      };
    } catch (e) {
      return {
        failure: { steps, error: e instanceof Error ? e.message : e },
        steps,
      };
    }
  });
  expect(roundTrip.failure, JSON.stringify(roundTrip.failure)).toBeNull();
  if (roundTrip.failure) return;
  expect(roundTrip.imported).toEqual({ value: undefined });
  expect(roundTrip.emptied).toBe(0);
  expect(roundTrip.restored).toBe(3);
  expect(roundTrip.garbage).toMatchObject({
    error: {
      _tag: "DatabaseError",
      operation: "import",
      message: "not an SQLite database image (bad header)",
    },
  });
  expect(roundTrip.corrupt).toMatchObject({
    error: { _tag: "DatabaseError", operation: "import" },
  });
  expect(
    String((roundTrip.corrupt as { error: { message: string } }).error.message),
  ).toMatch(
    /quick_check|deserialize|malformed/,
  );
  expect(roundTrip.still).toBe(3); // snapshot restored after the bad image
  expect(roundTrip.changes).toContainEqual({
    kind: "import",
    source: "host",
    changes: 0,
    schemaChanged: true,
  });
  await typeLine(page, "SELECT count(*) FROM tasks;");
  expect(after(await screen(page), "SELECT count(*) FROM tasks;\n")).toMatch(
    /^3\n/,
  );
  await expect(page.getByTestId("db-capabilities")).toContainText(
    "export: available · import: available · cancel: unavailable (needs crossOriginIsolated",
  );
  await expect(page.getByTestId("db-cancel")).toHaveCount(0);
  saveEvidence(`06-host-controls-${target}.txt`, await screen(page));
  await screenshot(page, "host-controls");
  expect(problems).toEqual([]);
});

test("static assets and cleanup: vendored Fiddle from this origin, worker gone after dispose", async ({ page }) => {
  const problems = collectProblems(page);
  await openEditor(page);
  const info = await page.evaluate(() => globalThis.window.__db0!.info);
  expect(info.libversion).toBe("3.54.0");
  expect(info.sourceId).toContain("4bfc6e53a9");
  expect(info.crossOriginIsolated).toBe(false);
  const vendorDir = await page.evaluate(() =>
    globalThis.window.__db0!.client.vendorDir
  );
  expect(vendorDir).toBe("/vendor/fiddle/");
  const wasm = await page.request.get("/vendor/fiddle/fiddle-module.wasm");
  expect(wasm.status()).toBe(200);
  expect(wasm.headers()["content-type"]).toContain("application/wasm");

  await typeLine(page, "SELECT 1;");
  await idle(page);
  const workersBefore = page.workers().length;
  expect(workersBefore).toBeGreaterThanOrEqual(1);
  await page.evaluate(() => globalThis.window.__db0!.dispose());
  await expect(page.getByTestId("db0-status")).toHaveText(
    "editor disposed (worker terminated)",
  );
  await expect(page.getByTestId("db-editor")).toHaveCount(0);
  await expect.poll(() => page.workers().length).toBe(workersBefore - 1);
  expect(await page.evaluate(() => globalThis.window.__db0!.binding.terminal))
    .toBeUndefined();
  expect(problems).toEqual([]);
});
