// Native Deno driver backed by node:sqlite DatabaseSync (Deno 2.2+).
import { DatabaseSync } from "node:sqlite";
import { nodeExecute } from "./node-sqlite-exec.ts";
import type { DriverFactory } from "./service.ts";

const q = (s: string) => `'${s.replaceAll("'", "''")}'`;

/** node:sqlite in Deno 2.7.14 has no serialize()/deserialize(): replay schema + copy rows via ATTACH. */
const importIntoMemory = async (db: DatabaseSync, bytes: Uint8Array) => {
  const tmp = await Deno.makeTempFile({ suffix: ".sqlite" });
  try {
    await Deno.writeFile(tmp, bytes);
    db.exec(`ATTACH ${q(tmp)} AS src`);
    const objs = db.prepare(
      "SELECT type, name, sql FROM src.sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type = 'table' DESC, rowid",
    ).all() as { type: string; name: string; sql: string }[];
    const uv = (db.prepare("PRAGMA src.user_version").get() as { user_version: number }).user_version;
    db.exec("BEGIN");
    for (const o of objs.filter((o) => o.type === "table")) {
      db.exec(o.sql);
      db.exec(`INSERT INTO main."${o.name.replaceAll('"', '""')}" SELECT * FROM src."${o.name.replaceAll('"', '""')}"`);
    }
    for (const o of objs.filter((o) => o.type !== "table")) db.exec(o.sql);
    db.exec(`PRAGMA main.user_version = ${Number(uv)}`);
    db.exec("COMMIT");
    db.exec("DETACH src");
  } finally {
    await Deno.remove(tmp);
  }
};

export const nodeSqliteFactory = (
  path = ":memory:",
  hooks: { onClose?: () => void } = {},
): DriverFactory => ({
  label: `node:sqlite ${path}`,
  capabilities: { persistence: path === ":memory:" ? "memory" : "file", export: true, import: true, cancellation: false },
  open: async ({ fresh, bytes }) => {
    if (path !== ":memory:" && (fresh || bytes)) {
      for (const suffix of ["", "-wal", "-shm", "-journal"]) {
        try { await Deno.remove(path + suffix); } catch { /* absent */ }
      }
    }
    if (bytes && path !== ":memory:") await Deno.writeFile(path, bytes);
    const db = new DatabaseSync(path);
    if (bytes && path === ":memory:") await importIntoMemory(db, bytes);
    return {
      execute: (sql) => nodeExecute(db, sql),
      exportBytes: async () => {
        const tmp = await Deno.makeTempFile({ suffix: ".sqlite" });
        await Deno.remove(tmp);
        db.exec(`VACUUM INTO '${tmp.replaceAll("'", "''")}'`);
        const out = await Deno.readFile(tmp);
        await Deno.remove(tmp);
        return out;
      },
      close: () => {
        db.close();
        hooks.onClose?.();
      },
    };
  },
});
