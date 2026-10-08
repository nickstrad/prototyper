import { Context, Effect, Exit, Layer, Scope } from "effect";
import { Database, layer } from "../src/service.ts";
import { TASKS_SCHEMA, TASKS_SEED } from "../src/protocol.ts";
import { nodeSqliteFactory } from "../src/node-driver.ts";
import { wasmMemoryFactory } from "../src/wasm-driver-deno.ts";
for (const f of [nodeSqliteFactory(), wasmMemoryFactory()]) {
  const scope = Effect.runSync(Scope.make());
  const db = Context.get(await Effect.runPromise(Layer.build(layer({ factory: f, schema: TASKS_SCHEMA, seed: TASKS_SEED })).pipe(Scope.provide(scope))), Database);
  const bytes = await Effect.runPromise(db.exportBytes());
  const bad = bytes.slice(); bad.fill(0xAB, 100); // valid 16-byte header, garbage after
  const r = await Effect.runPromise(Effect.result(db.importBytes(bad)));
  const after = await Effect.runPromise(Effect.result(db.execute("SELECT count(*) FROM tasks")));
  console.log(f.label, JSON.stringify(r._tag === "Failure" ? { tag: r.failure._tag, op: r.failure.operation, msg: r.failure.message } : r), "after:", JSON.stringify(after._tag === "Success" ? after.success.rows : after.failure.message));
  await Effect.runPromise(Scope.close(scope, Exit.void));
}
