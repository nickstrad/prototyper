import { Effect, Exit, Scope } from "effect";
import type { DatabaseService } from "../../packages/core/types.ts";
import { encodeResult } from "../../packages/database/sqlite-cells.ts";
import { snapshot } from "../../packages/core/events.ts";
import { browserSqliteBackend } from "../../packages/database/sqlite-browser.ts";
import { make } from "../../packages/database/sqlite-service.ts";
import { spawnEngineWorker } from "../../packages/database/worker-client.ts";
import { shellQuery } from "../../packages/database/sqlite-shell-client.ts";
import { createTransferTools } from "../../packages/database/transfer/mod.ts";
import { duckDbPersistence } from "../../packages/database/transfer/duckdb.ts";
import { duckDbHandle } from "../../packages/database/duckdb-service.ts";

const scope = Effect.runSync(Scope.make());
const engine = new URL(location.href).searchParams.get("engine") ?? "sqlite";
const client = engine === "sqlite" ? spawnEngineWorker() : undefined;
const schema =
  "CREATE TABLE records (id INTEGER PRIMARY KEY, label TEXT, n BIGINT, data BLOB)";
const seed = engine === "sqlite"
  ? "INSERT INTO records VALUES (1, 'seed', 9007199254740993, X'00ff')"
  : "INSERT INTO records VALUES (1, 'seed', 9007199254740993, '\\x00\\xff'::BLOB)";
let checkpoints = 0;
const service: DatabaseService = await Effect.runPromise(
  (engine === "sqlite"
    ? make({
      schema,
      seed,
      backend: browserSqliteBackend({ client, persistence: "memory" }),
    })
    : duckDbPersistence({
      schema,
      seed,
      name: "r8-transfer",
    })).pipe(
      Scope.provide(scope),
    ),
);
// Observe successful real SQL, rather than the pre-CHECKPOINT service hook.
// The local WASM declaration omits this real AsyncDuckDB method.
const db = duckDbHandle(service)?.db as
  | { runQuery(connection: number, sql: string): Promise<Uint8Array> }
  | undefined;
if (db) {
  const runQuery = db.runQuery.bind(db);
  db.runQuery = async (connection, sql) => {
    const result = await runQuery(connection, sql);
    if (sql === "CHECKPOINT") checkpoints++;
    return result;
  };
}
const tools = createTransferTools(service);
let image: Uint8Array;
let cached: unknown;
let refreshes = 0;
const refresh = async () => {
  cached = await Effect.runPromise(snapshot(service));
  refreshes++;
};
await refresh();
tools.registerInterface(refresh);
// The shell is acquired before import and remains alive through success/recovery.
const duckConnection = await duckDbHandle(service)?.db.connect();
const shell = async () =>
  client
    ? encodeResult(
      await shellQuery(client, "SELECT * FROM records ORDER BY id"),
    )
    : (await duckConnection!.query("SELECT label FROM records ORDER BY id"))
      .toArray().map((r) => r.toJSON());
const harness = {
  persistence: tools.persistence,
  checkpoints: () => checkpoints,
  capabilities: tools.capabilities,
  path: duckDbHandle(service)?.path,
  exec: async (sql: string) =>
    encodeResult(await Effect.runPromise(service.execute(sql))),
  snapshot: () => Effect.runPromise(snapshot(service)),
  cached: () => ({ cached, refreshes }),
  shell,
  save: async () => {
    const file = await tools.exportDatabase();
    image = file.bytes;
    return { name: file.name, length: image.length };
  },
  restore: () => tools.importDatabase(image),
  corrupt: async () => {
    // Valid header, invalid first B-tree page: exercises destructive open/recovery.
    const bad = image.slice();
    bad[100] = 0xff;
    try {
      await tools.importDatabase(bad);
      return "unexpected success";
    } catch (error) {
      return String(error);
    }
  },
  parquet: async () => {
    const file = await tools.exportParquet({ name: 'odd".table' });
    const db = duckDbHandle(service)!.db;
    await db.registerFileBuffer("verify.parquet", file.bytes.slice());
    try {
      return {
        magic: new TextDecoder().decode(file.bytes.subarray(0, 4)),
        result: encodeResult(
          await Effect.runPromise(
            service.execute(
              "SELECT * FROM read_parquet('verify.parquet') ORDER BY id",
            ),
          ),
        ),
        leftovers: (await db.globFiles("transfer-*.parquet")).length,
      };
    } finally {
      await db.dropFiles(["verify.parquet"]);
    }
  },
  close: async () => {
    await duckConnection?.close();
    await Effect.runPromise(Scope.close(scope, Exit.void));
    client?.terminate();
  },
};
declare global {
  var r8: typeof harness;
}
globalThis.r8 = harness;
