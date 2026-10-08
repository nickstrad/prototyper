// Cross-engine result-shape parity: node:sqlite (Deno native) vs sqlite-wasm (same build as browser).
import { assertEquals } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { nodeExecute } from "../src/node-sqlite-exec.ts";
import { wasmExecute } from "../src/wasm-exec.ts";

const SETUP = `CREATE TABLE v (i INTEGER, big INTEGER, t TEXT, b BLOB, r REAL, n);
INSERT INTO v VALUES (42, 9007199254740993, 'héllo', x'00ff10', 1.5, NULL);`;
const CASES = [
  "SELECT * FROM v",
  "SELECT i, i AS i, 1 = 1 AS bool, true AS t2, 2 > 3 AS f, i + 0.0 AS fl, count(*) FROM v",
  "SELECT -9223372036854775808 AS minint, 9223372036854775807 AS maxint, 2.0 AS two_real",
  "INSERT INTO v (i) VALUES (1); SELECT count(*) AS c FROM v; SELECT 'second'",
  "-- comment only\n",
  "PRAGMA table_info(v)",
];

Deno.test("node:sqlite and sqlite-wasm produce identical JSON results", async () => {
  const sqlite3 = await sqlite3InitModule();
  const w = new sqlite3.oo1.DB(":memory:", "c");
  const n = new DatabaseSync(":memory:");
  w.exec(SETUP);
  n.exec(SETUP);
  const out: Record<string, unknown> = {
    versions: { wasm: sqlite3.version.libVersion, node: (n.prepare("select sqlite_version() v").get() as { v: string }).v },
  };
  for (const sql of CASES) {
    const a = wasmExecute(w, sql);
    const b = nodeExecute(n, sql);
    assertEquals(b, a, sql);
    out[sql] = a;
  }
  await Deno.writeTextFile(new URL("../evidence/deno-shape-parity.json", import.meta.url), JSON.stringify(out, null, 2));
});
