// Seeded model test across interfaces (R4): random sequences of task
// operations, each routed through the CLI, the API or the application on
// ONE runtime, must leave the database in the state a reference model
// predicts, and every interface must report that same state. Fixed seed,
// verbose reporting, and PROTOTYPER_REPLAY_PATH="<path>" replays a reported
// failure (same seed) straight to the shrunk counterexample. The path is
// applied to BOTH backend steps; the failing step's name says which backend.
import { assertEquals } from "@std/assert";
import fc from "fast-check";
import { Effect, Exit } from "effect";
import { SEED_TASKS } from "../../prototypes/task-manager/seed.ts";
import {
  type Backend,
  BACKENDS,
  type Instance,
  withInstance,
} from "../coherence/harness.ts";

export const SEED = 20261008;
const replayPath = Deno.env.get("PROTOTYPER_REPLAY_PATH");

type Via = "cli" | "api" | "app";
export type Op =
  | { kind: "create"; via: Via; title: string }
  | { kind: "complete"; via: Via; id: number }
  | { kind: "rename"; via: Via; id: number; title: string }
  | { kind: "delete"; via: Via; id: number }
  | { kind: "reset"; via: Via };

const via = fc.constantFrom<Via>("cli", "api", "app");
// Titles the CLI can carry inside double quotes; the model trims like the app.
const title = fc.stringMatching(/^[A-Za-z0-9 _.-]{0,12}$/);
const id = fc.integer({ min: 0, max: 7 });
export const opArb: fc.Arbitrary<Op> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.record({ kind: fc.constant("create" as const), via, title }),
  },
  {
    weight: 3,
    arbitrary: fc.record({ kind: fc.constant("complete" as const), via, id }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant("rename" as const),
      via,
      id,
      title,
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({ kind: fc.constant("delete" as const), via, id }),
  },
  {
    weight: 1,
    arbitrary: fc.record({ kind: fc.constant("reset" as const), via }),
  },
);

export type ModelTask = { id: number; title: string; completed: boolean };
export const seedModel = (): ModelTask[] =>
  SEED_TASKS.map((t) => ({ id: t.id, title: t.title, completed: t.completed }));

/** Applies one op to the model; returns whether the real op must succeed. */
export const applyToModel = (model: ModelTask[], op: Op): boolean => {
  switch (op.kind) {
    case "create": {
      const t = op.title.trim();
      if (!t) return false;
      // SQLite INTEGER PRIMARY KEY without AUTOINCREMENT: max(id) + 1, so an
      // id freed by deleting the newest task is reused (R1's documented rule).
      const nextId = model.length ? Math.max(...model.map((m) => m.id)) + 1 : 1;
      model.push({ id: nextId, title: t, completed: false });
      return true;
    }
    case "complete": {
      const m = model.find((x) => x.id === op.id);
      if (!m) return false;
      m.completed = true;
      return true;
    }
    case "rename": {
      const m = model.find((x) => x.id === op.id);
      const t = op.title.trim();
      if (!m || !t) return false;
      m.title = t;
      return true;
    }
    case "delete": {
      const idx = model.findIndex((x) => x.id === op.id);
      if (idx < 0) return false;
      model.splice(idx, 1);
      return true;
    }
    case "reset":
      model.splice(0, model.length, ...seedModel());
      return true;
  }
};

/** Runs one op through the chosen interface; returns whether it succeeded. */
export const runOp = async (i: Instance, op: Op): Promise<boolean> => {
  const q = (s: string) => `"${s.replaceAll('"', '\\"')}"`;
  switch (op.via) {
    case "cli": {
      const line = op.kind === "create"
        ? `tasks create ${q(op.title)}`
        : op.kind === "complete"
        ? `tasks complete ${op.id}`
        : op.kind === "rename"
        ? `tasks update ${op.id} --title ${q(op.title)}`
        : op.kind === "delete"
        ? `tasks delete ${op.id}`
        : "db reset";
      return (await i.cli(line)).exitCode === 0;
    }
    case "api": {
      const r = op.kind === "create"
        ? await i.api("POST", "/tasks", { title: op.title })
        : op.kind === "complete"
        ? await i.api("POST", `/tasks/${op.id}/complete`)
        : op.kind === "rename"
        ? await i.api("PATCH", `/tasks/${op.id}`, { title: op.title })
        : op.kind === "delete"
        ? await i.api("DELETE", `/tasks/${op.id}`)
        : await i.api("POST", "/reset");
      return r.status >= 200 && r.status < 300;
    }
    case "app": {
      const eff: Effect.Effect<unknown, unknown> = op.kind === "create"
        ? i.app.createTask(op.title)
        : op.kind === "complete"
        ? i.app.completeTask(op.id)
        : op.kind === "rename"
        ? i.app.updateTask(op.id, { title: op.title })
        : op.kind === "delete"
        ? i.app.deleteTask(op.id)
        : i.app.reset();
      return Exit.isSuccess(await Effect.runPromiseExit(eff));
    }
  }
};

export const observedState = async (i: Instance) => {
  const app = (await i.run(i.app.listTasks())).map((t) => ({
    id: t.id,
    title: t.title,
    completed: t.completed,
  }));
  const api = (await i.api("GET", "/tasks")).json.map((
    t: ModelTask,
  ) => ({ id: t.id, title: t.title, completed: t.completed }));
  const cli = JSON.parse((await i.cli("tasks list --json")).stdout).map((
    t: ModelTask,
  ) => ({ id: t.id, title: t.title, completed: t.completed }));
  return { app, api, cli };
};

/** The property: run `ops` on a fresh instance, compare with the model. */
export const property = (
  oracle: (model: ModelTask[], op: Op) => boolean = applyToModel,
  backend: Backend = "node:sqlite memory",
) =>
  fc.asyncProperty(fc.array(opArb, { maxLength: 10 }), async (ops) => {
    await withInstance(backend, async (i) => {
      const model = seedModel();
      let writes = 0;
      for (const op of ops) {
        const expectOk = oracle(model, op);
        const ok = await runOp(i, op);
        if (ok !== expectOk) {
          throw new Error(
            `${op.via} ${op.kind} ${
              JSON.stringify(op)
            }: ok=${ok}, model expected ${expectOk}`,
          );
        }
        if (ok) writes++;
      }
      const { app, api, cli } = await observedState(i);
      const expected = JSON.stringify(model);
      for (
        const [name, seen] of [["app", app], ["api", api], [
          "cli",
          cli,
        ]] as const
      ) {
        if (JSON.stringify(seen) !== expected) {
          throw new Error(
            `${name} state ${JSON.stringify(seen)} != model ${expected}`,
          );
        }
      }
      // One notification per successful write, through any interface.
      const log = await i.run(i.observer.drain());
      if (log.length !== writes) {
        throw new Error(`${log.length} notifications for ${writes} writes`);
      }
    });
  });

Deno.test("interfaces agree with the reference model (seeded, replayable)", async (t) => {
  for (const backend of BACKENDS) {
    await t.step(backend, () =>
      fc.assert(property(applyToModel, backend), {
        seed: SEED,
        numRuns: backend === "node:sqlite memory" ? 40 : 20,
        verbose: 1,
        ...(replayPath ? { path: replayPath, endOnFailure: true } : {}),
      }));
  }
});

Deno.test("sanity: the model's own seed matches the database seed", async () => {
  await withInstance("node:sqlite memory", async (i) => {
    assertEquals((await observedState(i)).app, seedModel());
  });
});
