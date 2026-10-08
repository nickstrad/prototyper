import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(":memory:");
db.exec("create table t(a integer, b text, c blob, d real); insert into t values (9007199254740993, 'x', x'0102', 1.5), (1, null, null, null)");
const st = db.prepare("select *, 1=1 as bool from t");
console.log("columns()", typeof st.columns === "function" ? st.columns().map(c=>c.name) : "n/a");
try { console.log("default all()", st.all()); } catch (e) { console.log("default all() error:", String(e)); }
st.setReadBigInts(true); console.log("readBigInts all()", st.all());
st.setReadBigInts(false);
if (typeof st.setReturnArrays === "function") { st.setReturnArrays(true); try { console.log("arrays", st.all()); } catch (e) { console.log("arrays err", String(e)); } } else console.log("no setReturnArrays");
const ins = db.prepare("insert into t(a) values (?)"); console.log("run()", ins.run(5));
const upd = db.prepare("select 1"); console.log("run() on select", upd.run());
try { db.exec("selec 1"); } catch (e) { console.log("error shape", e.constructor.name, e.code, e.errcode, e.errstr, String(e)); }
console.log("deno", Deno.version);
