import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
console.log("resolved", import.meta.resolve("@sqlite.org/sqlite-wasm"));
const sqlite3 = await sqlite3InitModule();
const f = Deno.args[0];
try {
  const db = new sqlite3.oo1.DB(f, "c");
  db.exec("create table if not exists t(a); insert into t values (1)");
  console.log("count", db.selectValue("select count(*) from t"), "filename", db.filename);
  db.close();
} catch (e) { console.log("file db error:", String(e)); }
try { console.log("real file exists?", Deno.statSync(f).size); } catch (e) { console.log("no real file:", String(e)); }
