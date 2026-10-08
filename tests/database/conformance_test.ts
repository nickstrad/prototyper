// D1 conformance suite under Deno: node:sqlite (memory and a real file) and
// @sqlite.org/sqlite-wasm memory. The browser run (Fiddle engine) lives in
// tests/database/sqlite-browser.spec.ts and runs the same cases.
import { Effect, Layer } from "effect";
import {
  conformanceCases,
  type ConformanceTarget,
} from "../../packages/database/conformance.ts";
import { nativeSqliteBackend } from "../../packages/database/native-sqlite.ts";
import { layer } from "../../packages/database/sqlite-service.ts";
import { sqliteWasmMemoryBackend } from "../../packages/database/sqlite-wasm.ts";
import {
  TASKS_SCHEMA,
  TASKS_SEED,
} from "../../packages/database/sqlite-seed.ts";

const seeded = { schema: TASKS_SCHEMA, seed: TASKS_SEED };

const targets: ConformanceTarget[] = [
  {
    name: "node:sqlite memory",
    expectPersistence: "memory",
    layer: (hooks) => layer({ ...seeded, backend: nativeSqliteBackend(hooks) }),
  },
  {
    name: "node:sqlite file",
    expectPersistence: "memory",
    layer: (hooks) =>
      Layer.unwrap(Effect.sync(() => {
        const path = Deno.makeTempFileSync({
          prefix: "d1-",
          suffix: ".sqlite",
        });
        return layer({
          ...seeded,
          backend: nativeSqliteBackend({
            path,
            onClose: hooks.onClose,
            onDispose: () => {
              hooks.onDispose();
              for (const s of ["", "-journal", "-wal", "-shm"]) {
                try {
                  Deno.removeSync(path + s);
                } catch { /* absent */ }
              }
            },
          }),
        });
      })),
  },
  {
    name: "sqlite-wasm memory",
    expectPersistence: "memory",
    layer: (hooks) =>
      layer({ ...seeded, backend: sqliteWasmMemoryBackend(hooks) }),
  },
];

for (const target of targets) {
  for (const c of conformanceCases) {
    Deno.test(`${target.name}: ${c.name}`, () => c.run(target));
  }
}
