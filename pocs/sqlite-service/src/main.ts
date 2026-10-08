import { Context, Effect, Exit, Layer, PubSub, Scope } from "effect";
import { TASKS_SCHEMA, TASKS_SEED } from "./protocol.ts";
import { Database, layer } from "./service.ts";
import { spawnWorker, workerFactory } from "./worker-client.ts";
import type { Vfs } from "./worker.ts";

/** Run the Effect DatabaseService in the browser over a worker-backed driver. */
const effectService = async (vfs: Vfs, sqls: string[]) => {
  let closes = 0;
  const scope = Effect.runSync(Scope.make());
  const live = layer({ factory: workerFactory(vfs, "/effect.sqlite3", { onClose: () => closes++ }), schema: TASKS_SCHEMA, seed: TASKS_SEED });
  const run = <A, E>(e: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(e.pipe(Scope.provide(scope)));
  const db = Context.get(await run(Layer.build(live)), Database);
  const sub = await run(db.subscribe);
  const results: unknown[] = [];
  for (const sql of sqls) {
    results.push(await Effect.runPromise(Effect.result(db.execute(sql))));
  }
  await Effect.runPromise(db.reset());
  const afterReset = await Effect.runPromise(db.execute("SELECT count(*) AS n FROM tasks"));
  const events = await Effect.runPromise(PubSub.takeUpTo(sub, 100));
  await Effect.runPromise(Scope.close(scope, Exit.void));
  return { label: db.label, results, afterReset, events, closes };
};

declare global {
  interface Window { poc: unknown }
}
window.poc = { spawnWorker, effectService, crossOriginIsolated: self.crossOriginIsolated };

const out = document.querySelector<HTMLPreElement>("#out")!;
const input = document.querySelector<HTMLTextAreaElement>("#sql")!;
const vfsSel = document.querySelector<HTMLSelectElement>("#vfs")!;
let rpc: Awaited<ReturnType<typeof spawnWorker>> | undefined;
document.querySelector("#open")!.addEventListener("click", async () => {
  rpc?.terminate();
  rpc = await spawnWorker();
  try {
    out.textContent = JSON.stringify(await rpc.call("open", { vfs: vfsSel.value }), null, 2);
    await rpc.call("exec", { sql: `PRAGMA user_version` });
  } catch (e) {
    out.textContent = String(e);
  }
});
document.querySelector("#run")!.addEventListener("click", async () => {
  try {
    out.textContent = JSON.stringify(await rpc!.call("exec", { sql: input.value }), null, 2);
  } catch (e) {
    out.textContent = String(e);
  }
});
out.textContent = `crossOriginIsolated=${self.crossOriginIsolated}; ready`;
document.body.dataset.ready = "1";
