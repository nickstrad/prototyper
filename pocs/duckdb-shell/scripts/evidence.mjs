// Step 2 + 3: drive the real upstream shell, save terminal output, prove live sharing.
import { writeFileSync, mkdirSync } from "node:fs";
import { launch, open, run, text } from "./lib.mjs";

const OUT = new URL("../evidence/", import.meta.url);
mkdirSync(OUT, { recursive: true });
const save = (name, body) => { writeFileSync(new URL(name, OUT), body.endsWith("\n") ? body : body + "\n"); console.log(`--- ${name}\n${body}`); };

const { browser, page, logs } = await launch();
await open(page, "?manual");
const info = await page.evaluate(async () => {
  const r = await window.poc.initDb();
  // Count connectInternal/disconnect calls made by the shell (test instrumentation only).
  const db = window.poc.db;
  window.connCalls = [];
  const ci = db.connectInternal.bind(db), dc = db.disconnect.bind(db);
  db.connectInternal = async () => { const id = await ci(); window.connCalls.push(`connectInternal -> ${id}`); return id; };
  db.disconnect = async (id) => { window.connCalls.push(`disconnect(${id})`); return dc(id); };
  await window.poc.mountShell("shell-1");
  return r;
});
await page.waitForTimeout(500);
save("00-banner.txt", `# env: ${JSON.stringify(info)}\n` + (await text(page)));

const cases = [
  ["01-help.txt", ".help"],
  ["02-features.txt", ".features"],
  ["03-show-tables.txt", "SHOW TABLES;"],
  ["04-describe-events.txt", "DESCRIBE events;"],
  ["05-select-events.txt", "SELECT * FROM events;"],
  ["06-multiline.txt", "SELECT kind,\n  count(*) AS n\nFROM events\nGROUP BY kind\nORDER BY kind;"],
  ["07-string-with-semicolon.txt", "SELECT 'a;b' AS s, length('x;y;z') AS len;"],
  ["08-error-then-valid.txt", "SELEC oops FROM events;\nSELECT count(*) AS ok FROM events;"],
  ["09-timer-on.txt", ".timer on\nSELECT count(*) FROM events;\n.timer off"],
  ["10-files.txt", ".files\n.files list"],
  ["12-mode-csv.txt", ".mode csv"],
  ["13-tables.txt", ".tables"],
  ["14-schema.txt", ".schema"],
  ["15-headers-on.txt", ".headers on"],
  ["16-mode-table-json.txt", ".mode table\n.mode json\n.mode"],
  ["17-examples-output-reset.txt", ".examples\n.output off\nSELECT 1;\n.output on\nSELECT 2;\n.reset"],
  ["18-sql-equivalents.txt",
    "SELECT table_name FROM duckdb_tables();\n" +
    "SELECT sql FROM duckdb_tables() WHERE table_name = 'events';\n" +
    "SUMMARIZE events;\n" +
    "SELECT to_json(e) AS j FROM events e LIMIT 2;\n" +
    "SELECT json_group_array(e) AS j FROM (SELECT * FROM events ORDER BY id LIMIT 2) e;\n" +
    "COPY (SELECT * FROM events ORDER BY id) TO 'events.csv' (FORMAT csv, HEADER);\n" +
    "SELECT * FROM read_csv('events.csv');\n" +
    ".files list\n" +
    "COPY (SELECT * FROM events) TO '/dev/stdout' (FORMAT csv);"],
  ["19-types-in-shell.txt", "SELECT 170141183460469231731687303715884105727::HUGEINT AS h, 9223372036854775807::BIGINT AS b, NULL AS n, [1,2,NULL] AS l, {'a': 1} AS st, '\\xAA'::BLOB AS bl, TIMESTAMP '2024-01-01 09:00:00' AS ts, 3.14::DECIMAL(5,2) AS d;"],
];
for (const [name, input] of cases) save(name, `# input:\n${input.split("\n").map((l) => "#   " + l).join("\n")}\n# output:\n` + (await run(page, input)));

// ---- Step 3: live sharing ----
const s = [];
const app = (sql) => page.evaluate((sql) => window.poc.appQuery(sql), sql);
s.push(`connect calls recorded so far (shell only; app conn opened before wrapping): ${JSON.stringify(await page.evaluate(() => window.connCalls))}`);
s.push(`app count before: ${JSON.stringify(await app("SELECT count(*)::INTEGER AS c FROM events"))}`);
s.push(`app INSERT (6,'app_write',...) -> ${JSON.stringify(await app("INSERT INTO events VALUES (6, 'app_write', TIMESTAMP '2024-02-01 00:00:00')"))}`);
s.push("shell after app insert:\n" + (await run(page, "SELECT count(*) FROM events;\nSELECT * FROM events WHERE id = 6;")));
s.push("shell INSERT:\n" + (await run(page, "INSERT INTO events VALUES (7, 'shell_write', TIMESTAMP '2024-02-02 00:00:00');")));
s.push(`app after shell insert: ${JSON.stringify(await app("SELECT * FROM events WHERE id >= 6 ORDER BY id"))}`);
// A second, fresh app connection too.
s.push(`fresh db.connect() sees: ${JSON.stringify(await page.evaluate(async () => { const c = await window.poc.db.connect(); const r = (await c.query("SELECT count(*)::INTEGER AS c FROM events")).toArray().map((x) => x.toJSON()); await c.close(); return r; }))}`);
// Transaction visibility: shell opens an explicit transaction.
s.push("shell BEGIN + INSERT (uncommitted):\n" + (await run(page, "BEGIN TRANSACTION;\nINSERT INTO events VALUES (8, 'shell_tx', NULL);\nSELECT count(*) FROM events;")));
s.push(`app during shell tx: ${JSON.stringify(await app("SELECT count(*)::INTEGER AS c FROM events"))}`);
s.push(`app write during shell tx: ${JSON.stringify(await app("INSERT INTO events VALUES (9, 'app_during_tx', NULL)").catch((e) => "ERROR " + e.message))}`);
s.push("shell COMMIT:\n" + (await run(page, "COMMIT;")));
s.push(`app after shell commit: ${JSON.stringify(await app("SELECT id, kind FROM events WHERE id >= 6 ORDER BY id"))}`);
// Conflict: both sides update the same row inside transactions.
s.push("shell BEGIN + UPDATE id=1:\n" + (await run(page, "BEGIN;\nUPDATE events SET kind = 'shell_upd' WHERE id = 1;")));
s.push(`app UPDATE id=1 while shell tx open: ${JSON.stringify(await app("UPDATE events SET kind = 'app_upd' WHERE id = 1").catch((e) => "ERROR " + e.message))}`);
s.push("shell COMMIT:\n" + (await run(page, "COMMIT;\nSELECT id, kind FROM events WHERE id = 1;")));
s.push("shell DDL (CREATE TABLE notes) then app reads it:\n" + (await run(page, "CREATE TABLE notes AS SELECT 1 AS id, 'from shell' AS body;")));
s.push(`app: ${JSON.stringify(await app("SELECT * FROM notes"))}`);
s.push(`connect calls total: ${JSON.stringify(await page.evaluate(() => window.connCalls))}`);
save("20-live-sharing.txt", s.join("\n\n"));
save("21-console.txt", logs.filter((l) => !l.includes("GL Driver")).join("\n"));
await browser.close();
