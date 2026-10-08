// R3 native suite, generic layer: packages/api/router.ts on a bare runtime
// (no database). Routing, JSON bodies, the expected-failure/defect split and
// encodeQueryResult.
import { assert, assertEquals, assertFalse } from "@std/assert";
import { Cause, Effect, Layer, ManagedRuntime } from "effect";
import {
  ApiFailure,
  created,
  encodeQueryResult,
  failure,
  makeApiHandler,
  ok,
  reply,
  route,
} from "../../packages/api/router.ts";

type Boom = { readonly _tag: "Boom"; readonly n: number };

const defects: Cause.Cause<unknown>[] = [];
const interrupted: string[] = [];
const touched: string[] = [];

const routes = [
  route<never, Boom>("GET", "/ping", () => Effect.succeed(ok({ pong: true }))),
  route<never, Boom>(
    "GET",
    "/items/:id/parts/:part",
    ({ params }) => Effect.succeed(ok(params)),
  ),
  route<never, Boom>("POST", "/items", ({ json }) =>
    Effect.gen(function* () {
      const body = yield* json;
      return created({ got: body ?? null }, "/items/1");
    })),
  route<never, Boom>(
    "GET",
    "/items",
    ({ query }) => Effect.succeed(ok({ q: query.get("q") })),
  ),
  route<never, Boom>(
    "DELETE",
    "/items",
    () => Effect.succeed(reply(204, undefined)),
  ),
  route<never, Boom>(
    "GET",
    "/expected",
    () => Effect.fail({ _tag: "Boom", n: 7 }),
  ),
  route<never, Boom>(
    "GET",
    "/direct",
    () =>
      Effect.fail(
        failure(418, "Teapot", "short and stout", { "x-extra": "1" }),
      ),
  ),
  route<never, Boom>(
    "GET",
    "/defect",
    () => Effect.die(new Error("secret internal detail")),
  ),
  route<never, Boom>("GET", "/throws", () =>
    Effect.sync(() => {
      throw new Error("secret thrown detail");
    })),
  route<never, Boom>("GET", "/interrupt", () => Effect.interrupt),
  route<never, Boom>("GET", "/hang", () =>
    Effect.never.pipe(
      Effect.onInterrupt(() => Effect.sync(() => interrupted.push("hang"))),
    )),
  route<never, Boom>("GET", "/touch", () =>
    Effect.sync(() => {
      touched.push("touch");
      return ok({});
    })),
  route<never, Boom>("GET", "/bigint", () => Effect.succeed(ok({ n: 1n }))),
];

const handlerOn = (runtime: ManagedRuntime.ManagedRuntime<never, unknown>) =>
  makeApiHandler({
    runtime,
    routes,
    mapError: (e: Boom) => failure(409, "Boom", `boom ${e.n}`),
    onDefect: (cause) => defects.push(cause),
  });

const call = async (
  handler: ReturnType<typeof handlerOn>,
  method: string,
  path: string,
  body?: string,
) => {
  const response = await handler(
    new Request(`https://api.invalid${path}`, { method, body }),
  );
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    text,
    // deno-lint-ignore no-explicit-any
    json: (text === "" ? undefined : JSON.parse(text)) as any,
  };
};

Deno.test("router: routing, params, bodies, failure mapping, defects", async (t) => {
  const runtime = ManagedRuntime.make(Layer.empty);
  const handler = handlerOn(runtime);
  try {
    await t.step("200 JSON with a JSON content type", async () => {
      const r = await call(handler, "GET", "/ping");
      assertEquals(r.status, 200);
      assertEquals(r.json, { pong: true });
      assertEquals(
        r.headers.get("content-type"),
        "application/json; charset=utf-8",
      );
    });

    await t.step(
      "params are percent-decoded; trailing slash is ignored",
      async () => {
        const r = await call(handler, "GET", "/items/a%20b/parts/%C3%A9/");
        assertEquals(r.json, { id: "a b", part: "é" });
      },
    );

    await t.step("malformed %-encoding is 400 InvalidPath", async () => {
      const r = await call(handler, "GET", "/items/%E0%A4%A/parts/x");
      assertEquals(r.status, 400);
      assertEquals(r.json.error.code, "InvalidPath");
    });

    await t.step(
      "a bad %-escape is 404 when the literal segments differ",
      async () => {
        const r = await call(handler, "GET", "/items/%E0%A4%A/other/x");
        assertEquals(r.status, 404);
        assertEquals(r.json.error.code, "RouteNotFound");
      },
    );

    await t.step(
      "an already-aborted request is 499 and never dispatched",
      async () => {
        const before = defects.length;
        const r = await handler(
          new Request("https://api.invalid/touch", {
            signal: AbortSignal.abort(),
          }),
        );
        assertEquals(r.status, 499);
        assertEquals((await r.json()).error.code, "RequestAborted");
        assertEquals(touched, []);
        assertEquals(defects.length, before, "an abort is not a defect");
      },
    );

    await t.step(
      "aborting mid-flight interrupts the route and answers 499",
      async () => {
        const before = defects.length;
        const controller = new AbortController();
        const pending = handler(
          new Request("https://api.invalid/hang", {
            signal: controller.signal,
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 20));
        controller.abort();
        const r = await pending;
        assertEquals(r.status, 499);
        assertEquals(interrupted, ["hang"]);
        assertEquals(defects.length, before, "an abort is not a defect");
      },
    );

    await t.step(
      "query string is available, 201 carries Location",
      async () => {
        assertEquals((await call(handler, "GET", "/items?q=hi")).json, {
          q: "hi",
        });
        const r = await call(handler, "POST", "/items", '{"a":[1,2]}');
        assertEquals(r.status, 201);
        assertEquals(r.headers.get("location"), "/items/1");
        assertEquals(r.json, { got: { a: [1, 2] } });
      },
    );

    await t.step("an empty body reads as undefined", async () => {
      const r = await call(handler, "POST", "/items");
      assertEquals(r.json, { got: null });
    });

    await t.step("malformed JSON is 400 InvalidJson", async () => {
      const r = await call(handler, "POST", "/items", "{nope");
      assertEquals(r.status, 400);
      assertEquals(r.json.error.code, "InvalidJson");
    });

    await t.step("204 has no body and no JSON content type", async () => {
      const r = await call(handler, "DELETE", "/items");
      assertEquals(r.status, 204);
      assertEquals(r.text, "");
      assertEquals(r.headers.get("content-type"), null);
    });

    await t.step("unknown path is 404 RouteNotFound", async () => {
      const r = await call(handler, "GET", "/nothing/here");
      assertEquals(r.status, 404);
      assertEquals(r.json.error.code, "RouteNotFound");
    });

    await t.step("known path, other method is 405 with Allow", async () => {
      const r = await call(handler, "PATCH", "/items");
      assertEquals(r.status, 405);
      assertEquals(r.json.error.code, "MethodNotAllowed");
      assertEquals(r.headers.get("allow"), "DELETE, GET, POST");
    });

    await t.step("typed failures go through mapError", async () => {
      const r = await call(handler, "GET", "/expected");
      assertEquals(r.status, 409);
      assertEquals(r.json, { error: { code: "Boom", message: "boom 7" } });
    });

    await t.step("a route may fail with an ApiFailure directly", async () => {
      const r = await call(handler, "GET", "/direct");
      assertEquals(r.status, 418);
      assertEquals(r.json.error.code, "Teapot");
      assertEquals(r.headers.get("x-extra"), "1");
      assert(failure(1, "a", "b") instanceof ApiFailure);
    });

    for (const path of ["/defect", "/throws", "/interrupt", "/bigint"]) {
      await t.step(`${path}: 500 InternalError, no detail leaked`, async () => {
        const before = defects.length;
        const r = await call(handler, "GET", path);
        assertEquals(r.status, 500);
        assertEquals(r.json.error.code, "InternalError");
        assertFalse(r.text.includes("secret"), r.text);
        assertEquals(defects.length, before + 1, "onDefect saw it");
      });
    }
    assert(
      defects.some((c) => Cause.pretty(c).includes("secret internal detail")),
      "the detail is available to onDefect",
    );
  } finally {
    await runtime.dispose();
  }
});

Deno.test("router: a failing or disposed runtime still answers with a Response", async () => {
  const seen: unknown[] = [];
  const failing = ManagedRuntime.make(
    Layer.effectDiscard(Effect.die(new Error("layer exploded"))),
  );
  const onDefect = (c: Cause.Cause<unknown>) => seen.push(c);
  const handler = makeApiHandler({
    runtime: failing as unknown as ManagedRuntime.ManagedRuntime<
      never,
      unknown
    >,
    routes,
    mapError: (e: Boom) => failure(409, "Boom", String(e.n)),
    onDefect,
  });
  const r = await handler(new Request("https://api.invalid/ping"));
  assertEquals(r.status, 500);
  assertEquals((await r.json()).error.code, "InternalError");
  assertEquals(seen.length, 1);

  const disposed = ManagedRuntime.make(Layer.empty);
  await disposed.dispose();
  const handler2 = makeApiHandler({
    runtime: disposed,
    routes,
    mapError: (e: Boom) => failure(409, "Boom", String(e.n)),
    onDefect,
  });
  assertEquals(
    (await handler2(new Request("https://api.invalid/ping"))).status,
    500,
  );
});

Deno.test("encodeQueryResult: bigint and blob cells are tagged, the rest unchanged", () => {
  const encoded = encodeQueryResult({
    columns: ["a", "b", "c", "d", "e"],
    rows: [[1, "x", null, 9007199254740993n, new Uint8Array([0, 255])]],
    changes: 0,
    schemaChanged: false,
    truncated: false,
  });
  assertEquals(encoded.rows, [[
    1,
    "x",
    null,
    { $type: "bigint", value: "9007199254740993" },
    { $type: "blob", base64: "AP8=" },
  ]]);
  // The whole result survives JSON, which raw bigint would not.
  assertEquals(JSON.parse(JSON.stringify(encoded)), encoded);
});
