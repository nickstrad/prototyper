// Prototype-instance lifecycle, native half (R4): close/reopen cycles of the
// one runtime hosting every interface leak nothing observable, a closed
// instance refuses work with a typed error, a reopened one starts at the
// exact seed, and two subscribers each receive exactly one notification per
// write (no duplication, no cross-talk when one leaves).
import { assert, assertEquals } from "@std/assert";
import { Effect, Exit, Scope } from "effect";
import {
  observeChanges,
  sameSnapshot,
  type Snapshot,
} from "../../packages/core/events.ts";
import {
  BACKENDS,
  forEachBackend,
  withInstance,
} from "../coherence/harness.ts";

Deno.test("six close/reopen cycles: each instance starts at the seed and ends cleanly", async (t) => {
  for (const backend of BACKENDS) {
    await t.step(backend, async () => {
      let seed: Snapshot | undefined;
      let closedDb: Parameters<typeof afterClose>[0] | undefined;
      for (let cycle = 1; cycle <= 6; cycle++) {
        await withInstance(backend, async (i) => {
          const s = await i.snap();
          if (seed) {
            assert(sameSnapshot(seed, s), `cycle ${cycle} starts at the seed`);
          }
          seed = s;
          const r = await i.cli(`tasks create "cycle ${cycle}"`);
          assertEquals(r.exitCode, 0);
          assertEquals((await i.api("GET", "/tasks")).json.length, 4);
          closedDb = i.db;
        });
        // The closed instance refuses work with a typed DatabaseError.
        const exit = await Effect.runPromiseExit(closedDb!.execute("SELECT 1"));
        assert(Exit.isFailure(exit));
        assertEquals(await afterClose(closedDb!), "DatabaseError");
      }
    });
  }
});

const afterClose = (
  db: { execute(sql: string): Effect.Effect<unknown, { _tag: string }> },
) =>
  Effect.runPromise(
    db.execute("SELECT 1").pipe(
      Effect.match({ onFailure: (e) => e._tag, onSuccess: () => "succeeded" }),
    ),
  );

Deno.test("two observers each see exactly one notification per write; leaving one changes nothing", (t) =>
  forEachBackend(t, BACKENDS, async (i) => {
    const scope = Effect.runSync(Scope.make());
    const second = await Effect.runPromise(
      Scope.provide(scope)(observeChanges(i.db)),
    );
    await i.cli('tasks create "shared"');
    await i.api("POST", "/tasks/4/complete");
    assertEquals((await i.run(i.observer.drain())).length, 2);
    assertEquals((await i.run(second.drain())).length, 2);
    await Effect.runPromise(Scope.close(scope, Exit.void));
    await i.run(i.app.deleteTask(4));
    assertEquals((await i.run(i.observer.drain())).length, 1);
    // A failed op after the second observer left publishes nothing either.
    await Effect.runPromiseExit(i.app.deleteTask(4));
    assertEquals(await i.run(i.observer.drain()), []);
  }));

Deno.test("closing the observer's scope ends its subscription while the instance is still live", async () => {
  await withInstance("node:sqlite memory", async (i) => {
    const scope = Effect.runSync(Scope.make());
    const observer = await Effect.runPromise(
      Scope.provide(scope)(observeChanges(i.db)),
    );
    await i.cli('tasks create "seen"');
    assertEquals((await i.run(observer.drain())).length, 1);
    // Close ONLY the observer's scope: the runtime, the service and its
    // PubSub stay alive. A drain must now fail (subscription gone), so a
    // harness that forgot to close the scope would still answer here and be
    // caught; the instance-level observer keeps working.
    await Effect.runPromise(Scope.close(scope, Exit.void));
    const exit = await Effect.runPromiseExit(observer.drain());
    assert(Exit.isFailure(exit), "drain on a closed observer scope must fail");
    await i.cli('tasks create "after the observer left"');
    assertEquals((await i.run(i.observer.drain())).length, 2);
  });
});

Deno.test("after the instance closes, draining fails and the closed db answers DatabaseError", async () => {
  let drainAfter: (() => Promise<unknown>) | undefined;
  let dbAfter: Parameters<typeof afterClose>[0] | undefined;
  await withInstance("node:sqlite memory", async (i) => {
    await i.cli('tasks create "before close"');
    drainAfter = () => i.run(i.observer.drain());
    assertEquals(((await drainAfter()) as unknown[]).length, 1);
    dbAfter = i.db;
  });
  // The service's PubSub is shut down with the runtime, so the drain fails
  // whether or not the harness closed the observer scope (the scope case is
  // the previous test); what this proves is that nothing is answered after
  // close.
  const exit = await Effect.runPromiseExit(
    Effect.promise(() => drainAfter!()),
  );
  assert(Exit.isFailure(exit), "drain after close must not succeed");
  assertEquals(await afterClose(dbAfter!), "DatabaseError");
});
