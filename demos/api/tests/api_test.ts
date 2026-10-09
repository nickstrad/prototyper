import { assertEquals } from "@std/assert";
import { Effect, Layer, ManagedRuntime } from "effect";
import { nativeSqliteBackend } from "../../../packages/database/native-sqlite.ts";
import { Database, layer } from "../../../packages/database/sqlite-service.ts";
import { createApi } from "../api.ts";
import { schema, seed } from "../schema.ts";

Deno.test("bookmark validation rejects bad bodies, URLs and ids without writes", async () => {
  const runtime = ManagedRuntime.make(
    layer({ backend: nativeSqliteBackend(), schema, seed }).pipe(Layer.orDie),
  );
  const handler = createApi(runtime);
  const post = (body: unknown) =>
    handler(
      new Request("https://api.invalid/bookmarks", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    );
  try {
    for (
      const body of [null, [], {}, { title: " ", url: "https://example.com" }, {
        title: "x",
        url: "javascript:alert(1)",
      }, { title: "x\0", url: "https://example.com" }]
    ) assertEquals((await post(body)).status, 400);
    for (const id of ["0", "-1", "abc", "9007199254740992", "1%20OR%201=1"]) {
      assertEquals(
        (await handler(
          new Request(`https://api.invalid/bookmarks/${id}`, {
            method: "DELETE",
          }),
        )).status,
        400,
      );
    }
    const injected = {
      title: "Robert'); DROP TABLE bookmarks;--",
      url: "https://example.com/",
    };
    assertEquals((await post(injected)).status, 201);
    const response = await handler(
      new Request("https://api.invalid/bookmarks"),
    );
    assertEquals(response.status, 200);
    const rows = await response.json();
    assertEquals(rows.length, 3);
    assertEquals(rows[2].title, injected.title);

    await runtime.runPromise(
      Effect.gen(function* () {
        const service = yield* Database;
        yield* service.execute(
          "INSERT INTO bookmarks(title, url) VALUES (x'00ff', 'https://example.com/blob')",
        );
      }),
    );
    const blobGet = await handler(
      new Request("https://api.invalid/bookmarks"),
    );
    const blobRows = await blobGet.json();
    assertEquals(blobRows[3], {
      id: 4,
      title: { $type: "blob", base64: "AP8=" },
      url: "https://example.com/blob",
    });
    const blobDelete = await handler(
      new Request("https://api.invalid/bookmarks/4", { method: "DELETE" }),
    );
    assertEquals(await blobDelete.json(), blobRows[3]);
  } finally {
    await runtime.dispose();
  }
});
