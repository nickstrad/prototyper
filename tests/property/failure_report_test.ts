// Proves the replay story the done-when line asks for: a deliberately wrong
// oracle makes the model test fail; fast-check reports the seed and a
// counterexample path; re-running with that seed and path reproduces the
// same shrunk counterexample without searching. Nothing here depends on the
// environment, so the proof runs on every `deno task test`.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import fc from "fast-check";
import {
  applyToModel,
  type Op,
  property,
  SEED,
} from "./interfaces_property_test.ts";

// Wrong oracle: claims completing a task that is absent still succeeds.
const wrongOracle = (model: Parameters<typeof applyToModel>[0], op: Op) =>
  op.kind === "complete"
    ? (applyToModel(model, op), true)
    : applyToModel(model, op);

Deno.test("a failing model test reports seed + path, and the path replays the counterexample", async () => {
  const first = await fc.check(property(wrongOracle), {
    seed: SEED,
    numRuns: 40,
    verbose: 1,
  });
  assert(first.failed, "the wrong oracle must be caught");
  assertEquals(first.seed, SEED);
  assert(
    typeof first.counterexamplePath === "string" &&
      first.counterexamplePath.length > 0,
  );
  const report = fc.defaultReportMessage(first)!;
  assertStringIncludes(report, `seed: ${SEED}`);
  assertStringIncludes(report, "path:");
  console.log(`---- fast-check report (expected failure) ----\n${report}`);

  const replay = await fc.check(property(wrongOracle), {
    seed: first.seed,
    path: first.counterexamplePath!,
    endOnFailure: true,
    numRuns: 40,
  });
  assert(replay.failed);
  assertEquals(replay.numRuns, 1, "replay goes straight to the counterexample");
  assertEquals(
    JSON.stringify(replay.counterexample),
    JSON.stringify(first.counterexample),
  );
  // The shrunk counterexample is minimal: a single absent-id complete.
  const [ops] = first.counterexample as [Op[]];
  assertEquals(ops.length, 1);
  assertEquals(ops[0].kind, "complete");
});
