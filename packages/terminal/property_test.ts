// fast-check with a fixed seed: each case gets a fresh runtime, disposed in
// finally. Replay a reported failure with PROTOTYPER_REPLAY_PATH="3:1:0:1".
import fc from "fast-check";
import { AppClock, makeTasksRuntime } from "./examples/tasks.ts";
import { runTasks } from "./examples/tasks-command.ts";

const SEED = 20261007;
const replayPath = Deno.env.get("PROTOTYPER_REPLAY_PATH");

type Op = { kind: "create"; title: string } | { kind: "complete"; id: number };
const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ kind: fc.constant("create" as const), title: fc.string() }),
  fc.record({
    kind: fc.constant("complete" as const),
    id: fc.integer({ min: 0, max: 6 }),
  }),
);

Deno.test("CLI task ops match a reference model", async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(opArb, { maxLength: 12 }), async (ops) => {
      const runtime = makeTasksRuntime(AppClock.fixed("2026-01-01T00:00:00Z"));
      try {
        const model: { id: number; title: string; completed: boolean }[] = [];
        for (const op of ops) {
          if (op.kind === "create") {
            const r = await runTasks(runtime, ["create", op.title]);
            const title = op.title.trim();
            if ((title.length > 0) !== (r.exitCode === 0)) {
              throw new Error(
                `create ${JSON.stringify(op.title)} exit ${r.exitCode}`,
              );
            }
            if (r.exitCode === 0) {
              model.push({ id: model.length + 1, title, completed: false });
            }
          } else {
            const r = await runTasks(runtime, ["complete", String(op.id)]);
            const t = model.find((m) => m.id === op.id);
            if (Boolean(t) !== (r.exitCode === 0)) {
              throw new Error(`complete ${op.id} exit ${r.exitCode}`);
            }
            if (t) t.completed = true;
          }
        }
        const listed = await runTasks(runtime, ["list", "--json"]);
        const actual = JSON.parse(listed.stdout).map((
          t: { id: number; title: string; completed: boolean },
        ) => ({ id: t.id, title: t.title, completed: t.completed }));
        if (JSON.stringify(actual) !== JSON.stringify(model)) {
          throw new Error("state mismatch");
        }
      } finally {
        await runtime.dispose();
      }
    }),
    {
      seed: SEED,
      numRuns: 100,
      verbose: 1,
      ...(replayPath ? { path: replayPath, endOnFailure: true } : {}),
    },
  );
});
