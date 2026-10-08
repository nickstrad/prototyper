// Property test: random operation sequences against node:sqlite match a plain
// reference model (validation, SQLite rowid reuse, reset to seed, typed
// errors). Fixed seed; replay a reported failure with
// PROTOTYPER_REPLAY_PATH="<path>" (see packages/terminal/property_test.ts).
import fc from "fast-check";
import { Effect } from "effect";
import type { Task } from "../../prototypes/task-manager/schema.ts";
import { SEED_TASKS } from "../../prototypes/task-manager/seed.ts";
import { withApp } from "./harness.ts";

const SEED = 20261008;
const replayPath = Deno.env.get("PROTOTYPER_REPLAY_PATH");

type Op =
  | { kind: "create"; title: string }
  | { kind: "complete" | "delete"; id: number }
  | { kind: "update"; id: number; title?: string; completed?: boolean }
  | { kind: "reset" };

const titleArb = fc.oneof(
  fc.string({ maxLength: 12 }),
  fc.constantFrom(
    "",
    "   ",
    " ☃ snow ",
    "O'Brien",
    "a\u0000b",
    "tab\there",
    "c1\u0085",
    "rlo\u202Eabc",
    "lone\uD800",
    "pair 🎉",
    "x".repeat(200),
    "y".repeat(201),
  ),
);
const idArb = fc.integer({ min: -1, max: 9 });
const opArb: fc.Arbitrary<Op> = fc.oneof(
  {
    arbitrary: fc.record({ kind: fc.constant("create"), title: titleArb }),
    weight: 4,
  },
  {
    arbitrary: fc.record({
      kind: fc.constantFrom("complete" as const, "delete" as const),
      id: idArb,
    }),
    weight: 3,
  },
  {
    arbitrary: fc.record(
      {
        kind: fc.constant("update" as const),
        id: idArb,
        title: titleArb,
        completed: fc.boolean(),
      },
      { requiredKeys: ["kind", "id"] },
    ),
    weight: 2,
  },
  { arbitrary: fc.record({ kind: fc.constant("reset" as const) }), weight: 1 },
);

/** The Title schema, restated independently. */
const validTitle = (raw: string): string | undefined => {
  const t = raw.trim();
  return t.length > 0 && t.length <= 200 &&
      !/[\p{Cc}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u.test(t) &&
      t.isWellFormed()
    ? t
    : undefined;
};

type Outcome = string; // "ok" | tag of the failure
type ModelTask = { -readonly [K in keyof Task]: Task[K] };

Deno.test("task operations match a reference model (node:sqlite)", async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(opArb, { maxLength: 15 }), async (ops) => {
      await withApp("node:sqlite memory", async (h) => {
        let model: ModelTask[] = SEED_TASKS.map((t) => ({ ...t }));
        let clockTicks = 0;
        for (const op of ops) {
          let expected: Outcome;
          let effect: Effect.Effect<unknown, { _tag: string }>;
          const found = "id" in op
            ? model.find((t) => t.id === op.id)
            : undefined;
          const validId = "id" in op && op.id > 0;
          switch (op.kind) {
            case "create": {
              const title = validTitle(op.title);
              effect = h.app.createTask(op.title);
              if (title === undefined) expected = "InvalidInput";
              else {
                expected = "ok";
                const id = Math.max(0, ...model.map((t) => t.id)) + 1;
                model.push({
                  id,
                  title,
                  completed: false,
                  createdAt: new Date(
                    Date.parse("2026-02-01T12:00:00.000Z") +
                      1000 * clockTicks,
                  ).toISOString(),
                });
                clockTicks++;
              }
              break;
            }
            case "complete":
              effect = h.app.completeTask(op.id);
              expected = !validId
                ? "InvalidInput"
                : found
                ? "ok"
                : "TaskNotFound";
              if (found) found.completed = true;
              break;
            case "delete":
              effect = h.app.deleteTask(op.id);
              expected = !validId
                ? "InvalidInput"
                : found
                ? "ok"
                : "TaskNotFound";
              if (found) model = model.filter((t) => t !== found);
              break;
            case "update": {
              const patch: { title?: string; completed?: boolean } = {};
              if (op.title !== undefined) patch.title = op.title;
              if (op.completed !== undefined) patch.completed = op.completed;
              effect = h.app.updateTask(op.id, patch);
              const title = op.title === undefined
                ? undefined
                : validTitle(op.title);
              const patchOk = (op.title === undefined || title !== undefined) &&
                (op.title !== undefined || op.completed !== undefined);
              expected = !validId || !patchOk
                ? "InvalidInput"
                : found
                ? "ok"
                : "TaskNotFound";
              if (expected === "ok" && found) {
                if (title !== undefined) found.title = title;
                if (op.completed !== undefined) found.completed = op.completed;
              }
              break;
            }
            case "reset":
              effect = h.app.reset();
              expected = "ok";
              model = SEED_TASKS.map((t) => ({ ...t }));
              break;
          }
          const r = await Effect.runPromise(Effect.result(effect));
          const actual = r._tag === "Success" ? "ok" : r.failure._tag;
          if (actual !== expected) {
            throw new Error(
              `${JSON.stringify(op)}: expected ${expected}, got ${actual}`,
            );
          }
        }
        const listed = await h.run(h.app.listTasks());
        if (JSON.stringify(listed) !== JSON.stringify(model)) {
          throw new Error(
            `state mismatch\n  actual: ${JSON.stringify(listed)}\n  model:  ${
              JSON.stringify(model)
            }`,
          );
        }
      });
    }),
    {
      seed: SEED,
      numRuns: 100,
      verbose: 1,
      ...(replayPath ? { path: replayPath, endOnFailure: true } : {}),
    },
  );
});
