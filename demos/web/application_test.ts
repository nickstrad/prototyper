import { assertEquals } from "@std/assert";
import { Effect, ManagedRuntime } from "effect";
import { Database, layer } from "../../packages/database/sqlite-service.ts";
import { nativeSqliteBackend } from "../../packages/database/native-sqlite.ts";
import { notesApplication, schema, seed } from "./application.ts";

Deno.test("notes operations persist SQL rows and reset the seed", async () => {
  const runtime = ManagedRuntime.make(
    layer({ backend: nativeSqliteBackend(), schema, seed }),
  );
  try {
    const db = await runtime.runPromise(Database);
    const app = notesApplication(db);
    const initial = await Effect.runPromise(app.list());
    await Effect.runPromise(app.create("It's a note; DROP TABLE notes;"));
    assertEquals(
      (await Effect.runPromise(
        db.execute("SELECT body FROM notes WHERE id = 3"),
      )).rows,
      [["It's a note; DROP TABLE notes;"]],
    );
    await Effect.runPromise(app.edit(3, "Edited\nbody"));
    assertEquals((await Effect.runPromise(app.list()))[2].body, "Edited\nbody");
    await Effect.runPromise(app.remove(1));
    assertEquals((await Effect.runPromise(app.list())).map((n) => n.id), [
      2,
      3,
    ]);
    await Effect.runPromise(app.reset());
    assertEquals(await Effect.runPromise(app.list()), initial);
  } finally {
    await runtime.dispose();
  }
});
