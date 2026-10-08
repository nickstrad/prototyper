// What does the shell's `.open` do to the shared AsyncDuckDB the app also uses?
import { writeFileSync } from "node:fs";
import { launch, open, run, text, settle } from "./lib.mjs";
const { browser, page, logs } = await launch();
await open(page, "?manual");
await page.evaluate(async () => {
  await window.poc.initDb();
  const db = window.poc.db;
  window.calls = [];
  for (const m of ["open", "reset", "connectInternal", "disconnect", "dropFiles", "registerOPFSFileName"]) {
    const f = db[m].bind(db);
    db[m] = async (...a) => { window.calls.push(`${m}(${JSON.stringify(a)})`); return f(...a); };
  }
  await window.poc.mountShell("shell-1");
});
const app = (sql) => page.evaluate((sql) => window.poc.appQuery(sql).catch((e) => "ERROR " + e.message), sql);
const out = [];
out.push("app before: " + JSON.stringify(await app("SELECT count(*)::INTEGER c FROM events")));
await run(page, "SELECT count(*) FROM events;");
for (const cmd of [".open", ".open foo.duckdb"]) {
  await page.evaluate(() => window.poc.termFocus(0));
  await page.keyboard.type(cmd, { delay: 5 }); await page.keyboard.press("Enter");
  const t = await settle(page, 0, 1500);
  out.push(`### after typing ${cmd} — FULL terminal buffer:\n${t}`);
  out.push(`db calls: ${JSON.stringify(await page.evaluate(() => window.calls))}`);
  out.push("app query after: " + JSON.stringify(await app("SELECT count(*)::INTEGER c FROM events")));
  out.push("app current_database: " + JSON.stringify(await app("SELECT current_database() AS d, (SELECT list(path) FROM duckdb_databases()) AS paths")));
}
out.push("shell after .open:\n" + (await run(page, "SELECT count(*) FROM events;\nSELECT database_name, path FROM duckdb_databases();")));
out.push("console:\n" + logs.filter((l) => !l.includes("GL Driver")).join("\n"));
writeFileSync(new URL("../evidence/11-open.txt", import.meta.url), out.join("\n\n") + "\n");
console.log(out.join("\n\n"));
await browser.close();
