import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { generatePrototype, parseConfig } from "../../tools/prototype-new.ts";

const config = {
  name: "second-notes",
  database: "sqlite",
  persistence: "memory",
  interfaces: ["cli", "api", "web"],
};
async function temporary(run: (root: string) => Promise<void>) {
  const root = await Deno.makeTempDir({ prefix: "r5-generator-" });
  try {
    await run(root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}
async function tree(path: string) {
  const result: Record<string, string> = {};
  for await (const entry of Deno.readDir(path)) {
    result[entry.name] = await Deno.readTextFile(`${path}/${entry.name}`);
  }
  return result;
}

for (const database of ["sqlite", "duckdb"]) {
  for (
    const interfaces of [
      [],
      ["cli"],
      ["api"],
      ["web"],
      ["cli", "api"],
      ["cli", "web"],
      ["api", "web"],
      ["cli", "api", "web"],
    ]
  ) {
    Deno.test(`interface selection + Database: ${database}/${interfaces.join("+") || "database-only"}`, () =>
      temporary(async (root) => {
        const output = `${root}/example`;
        const files = await generatePrototype({
          ...config,
          database,
          interfaces,
        }, output);
        for (
          const [iface, file] of [["cli", "commands.ts"], ["api", "api.ts"], [
            "web",
            "App.tsx",
          ]]
        ) assertEquals(files.includes(file), interfaces.includes(iface), file);
        for (
          const file of [
            "database.ts",
            "application.ts",
            "schema.ts",
            "config.ts",
          ]
        ) assert(files.includes(file), `Database requires ${file}`);
        const generated = await tree(output);
        assert(
          generated["config.ts"].includes('["database", ...config.interfaces]'),
        );
        assert(
          generated["database.ts"].includes(
            database === "sqlite"
              ? "browserSqliteLayer"
              : "/database/duckdb-service.ts",
          ),
        );
        assertEquals(files.includes("native.ts"), database === "sqlite");
        assertEquals(files.includes("proof.ts"), database === "sqlite");
        assert(
          !Object.values(generated).some((source) =>
            /\{\{[A-Z]+\}\}/.test(source)
          ),
        );
      }));
  }
}

Deno.test("deterministic output and normalized config order", () =>
  temporary(async (root) => {
    await generatePrototype(config, `${root}/one`);
    await generatePrototype(
      { ...config, interfaces: ["web", "cli", "api"] },
      `${root}/two`,
    );
    assertEquals(await tree(`${root}/one`), await tree(`${root}/two`));
  }));

Deno.test("overwrite refusal preserves populated/empty directories and files", () =>
  temporary(async (root) => {
    const dest = `${root}/existing`;
    await generatePrototype(config, dest);
    await Deno.writeTextFile(`${dest}/application.ts`, "user edits\n");
    const before = await tree(dest);
    await assertRejects(
      () => generatePrototype(config, dest),
      Deno.errors.AlreadyExists,
    );
    assertEquals(await tree(dest), before);
    await Deno.mkdir(`${root}/empty`);
    await assertRejects(
      () => generatePrototype(config, `${root}/empty`),
      Deno.errors.AlreadyExists,
    );
    assertEquals(await tree(`${root}/empty`), {});
    await Deno.writeTextFile(`${root}/file`, "sentinel");
    await assertRejects(
      () => generatePrototype(config, `${root}/file`),
      Deno.errors.AlreadyExists,
    );
    assertEquals(await Deno.readTextFile(`${root}/file`), "sentinel");
  }));

Deno.test("invalid config fails before output creation", () =>
  temporary(async (root) => {
    for (
      const invalid of [
        null,
        [],
        {},
        { ...config, name: "../escape" },
        { ...config, interfaces: ["cli", "cli"] },
        { ...config, interfaces: ["unknown"] },
        { ...config, database: "other" },
        { ...config, database: "duckdb", persistence: "opfs-sahpool" },
        { ...config, persistence: "opfs" },
        { ...config, extra: true },
      ]
    ) {
      assertThrows(() => parseConfig(invalid));
      await assertRejects(() => generatePrototype(invalid, `${root}/invalid`));
    }
    assertEquals(await tree(root), {});
    assertEquals(
      parseConfig({ ...config, database: "duckdb", persistence: "opfs" })
        .persistence,
      "opfs",
    );
  }));

Deno.test("generated SQLite second prototype runs CRUD plus SQL", () =>
  temporary(async (root) => {
    await generatePrototype(config, `${root}/second`);
    const { prove } = await import(`file://${root}/second/proof.ts`);
    assertEquals(await prove(), "second-notes: SQLite CRUD + SQL passed");
  }));

Deno.test("generated API shares SQLite with application and SQL", () =>
  temporary(async (root) => {
    await generatePrototype(config, `${root}/api-proof`);
    const base = `file://${root}/api-proof/`;
    const { Effect, Layer, ManagedRuntime } = await import("effect");
    const { Database } = await import(
      "../../packages/database/sqlite-service.ts"
    );
    const { nativeLayer } = await import(`${base}native.ts`);
    const { createApi } = await import(`${base}api.ts`);
    const { listNotes } = await import(`${base}application.ts`);
    const runtime = ManagedRuntime.make(Layer.orDie(nativeLayer()));
    try {
      const api = createApi(runtime);
      const request = (method: string, path: string, body?: unknown) =>
        api(
          new Request(`http://prototype${path}`, {
            method,
            body: body === undefined ? undefined : JSON.stringify(body),
          }),
        );
      assertEquals(
        (await request("PUT", "/notes/quoted", { body: "Nick's note" })).status,
        200,
      );
      const rows = await (await request("GET", "/notes")).json();
      assert(
        rows.some((row: { id: string; body: string }) =>
          row.id === "quoted" && row.body === "Nick's note"
        ),
      );
      assertEquals(
        (await request("PUT", "/notes/quoted", { body: "updated" })).status,
        200,
      );
      const sql = await runtime.runPromise(
        Effect.flatMap(
          Database,
          (db) => db.execute("SELECT body FROM notes WHERE id = 'quoted'"),
        ),
      );
      assertEquals(sql.rows, [["updated"]]);
      assertEquals(
        (await request("PUT", "/notes/invalid", { body: "\0" })).status,
        400,
      );
      assertEquals((await request("DELETE", "/notes/quoted")).status, 200);
      const remaining = await runtime.runPromise(listNotes()) as {
        id: string;
      }[];
      assert(!remaining.some((row) => row.id === "quoted"));
    } finally {
      await runtime.dispose();
    }
  }));

Deno.test("generated application validates note boundaries before mutations", () =>
  temporary(async (root) => {
    await generatePrototype(config, `${root}/validation`);
    const base = `file://${root}/validation/`;
    const { Effect, Layer, ManagedRuntime } = await import("effect");
    const { nativeLayer } = await import(`${base}native.ts`);
    const { putNote, deleteNote, listNotes } = await import(
      `${base}application.ts`
    );
    const runtime = ManagedRuntime.make(Layer.orDie(nativeLayer()));
    try {
      for (
        const value of [
          "x",
          "x".repeat(1000),
          "😀".repeat(500),
          "  quoted ' 😀 \n",
        ]
      ) {
        await runtime.runPromise(putNote(value, value));
        const rows = await runtime.runPromise(listNotes()) as {
          id: string;
          body: string;
        }[];
        assert(rows.some((row) => row.id === value && row.body === value));
        await runtime.runPromise(putNote(value, "updated"));
        await runtime.runPromise(deleteNote(value));
        const remaining = await runtime.runPromise(listNotes()) as {
          id: string;
        }[];
        assert(!remaining.some((row) => row.id === value));
      }
      await runtime.runPromise(putNote("sentinel", "unchanged"));
      const before = await runtime.runPromise(listNotes());
      for (
        const value of [
          undefined,
          null,
          1,
          true,
          {},
          [],
          "",
          " \t\n",
          "\u00a0",
          "x".repeat(1001),
          "😀".repeat(500) + "x",
          "a\0b",
          "\ud800",
          "\udfff",
          "a\ud800b",
        ]
      ) {
        for (
          const operation of [
            putNote(value, "body"),
            putNote("sentinel", value),
            deleteNote(value),
          ]
        ) {
          const result = await runtime.runPromise(Effect.result(operation));
          assertEquals(result._tag, "Failure");
          if (result._tag === "Failure") {
            assertEquals(
              (result.failure as { _tag: string })._tag,
              "InvalidInput",
            );
          }
          assertEquals(await runtime.runPromise(listNotes()), before);
        }
      }
    } finally {
      await runtime.dispose();
    }
  }));

Deno.test("generated list rejects truncation through core and API", () =>
  temporary(async (root) => {
    await generatePrototype(config, `${root}/bounded`);
    const base = `file://${root}/bounded/`;
    const { Effect, Layer, ManagedRuntime } = await import("effect");
    const { Database } = await import(
      "../../packages/database/sqlite-service.ts"
    );
    const { nativeLayer } = await import(`${base}native.ts`);
    const { listNotes, putNote } = await import(`${base}application.ts`);
    const { createApi } = await import(`${base}api.ts`);
    const runtime = ManagedRuntime.make(Layer.orDie(nativeLayer()));
    try {
      await runtime.runPromise(Effect.flatMap(Database, (db) =>
        db.execute(
          "DELETE FROM notes; WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1000) INSERT INTO notes SELECT printf('n%04d',x), 'body' FROM n",
        )));
      const rows = await runtime.runPromise(listNotes()) as unknown[];
      assertEquals(rows.length, 1000);
      await runtime.runPromise(putNote("over-limit", "body"));
      const result = await runtime.runPromise(Effect.result(listNotes()));
      assertEquals(result._tag, "Failure");
      if (result._tag === "Failure") {
        assertEquals((result.failure as { _tag: string })._tag, "ListTooLarge");
      }
      const response = await createApi(runtime)(
        new Request("http://prototype/notes"),
      );
      assertEquals(response.status, 500);
      assert((await response.text()).includes("ListTooLarge"));
    } finally {
      await runtime.dispose();
    }
  }));
