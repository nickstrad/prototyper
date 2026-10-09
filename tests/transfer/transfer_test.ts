import { assertEquals, assertRejects } from "@std/assert";
import { Buffer } from "node:buffer";
import { Effect } from "effect";
import type { DatabaseService } from "../../packages/core/types.ts";
import {
  createTransferTools,
  TransferImportError,
} from "../../packages/database/transfer/mod.ts";

function fake(overrides: Partial<DatabaseService> = {}): DatabaseService {
  // Only transfer methods are used; unused methods fail loudly if accessed.
  return {
    engine: "sqlite",
    persistence: { requested: "memory", actual: "memory" },
    capabilities: {
      export: { available: true },
      import: { available: true },
      persistence: { available: false, reason: "memory" },
      multiTab: { available: false, reason: "memory" },
      cancellation: { available: false, reason: "deferred" },
    },
    exportBytes: () => Effect.succeed(new Uint8Array([1, 2])),
    importBytes: () => Effect.void,
    ...overrides,
  } as DatabaseService;
}

Deno.test("unavailable operations fail before touching the database and preserve reasons", async () => {
  const service = fake();
  let calls = 0;
  const tools = createTransferTools(fake({
    capabilities: {
      ...service.capabilities,
      export: { available: false, reason: "blocked export" },
      import: { available: false, reason: "blocked import" },
    },
    importBytes: () => {
      calls++;
      return Effect.void;
    },
    exportBytes: () => {
      calls++;
      return Effect.succeed(new Uint8Array());
    },
  }));
  assertEquals(tools.capabilities.parquet.available, false);
  await assertRejects(() => tools.exportDatabase(), Error, "blocked export");
  await assertRejects(
    () => tools.importDatabase(new Uint8Array()),
    Error,
    "blocked import",
  );
  await assertRejects(
    () => tools.exportParquet({ name: "x" }),
    Error,
    "blocked export",
  );
  assertEquals(calls, 0);
  await assertRejects(
    () => createTransferTools(service).exportParquet({ name: "x" }),
    Error,
    "requires DuckDB",
  );
});

Deno.test("imports copy input and await all reconnects; unregister prevents stale callbacks", async () => {
  const seen: number[][] = [];
  const tools = createTransferTools(
    fake({
      importBytes: (bytes) =>
        Effect.sync(() => {
          seen.push([...bytes]);
        }),
    }),
  );
  const order: string[] = [];
  tools.registerInterface(async () => {
    await Promise.resolve();
    order.push("first");
    throw new Error("refresh failure");
  });
  tools.registerInterface(() => {
    order.push("second");
  });
  const unregister = tools.registerInterface(() => {
    order.push("disposed");
  });
  unregister();
  const bytes = new Uint8Array([42]);
  const pending = tools.importDatabase(bytes);
  bytes[0] = 99;
  const error = await assertRejects(() => pending, TransferImportError);
  assertEquals(error.imported, true);
  assertEquals(error.errors.length, 1);
  assertEquals(seen, [[42]]);
  assertEquals(order, ["first", "second"]);
  // A rejected import/reconnect must not poison the queue.
  assertEquals([...(await tools.exportDatabase()).bytes], [1, 2]);
});

Deno.test("failed imports still reconnect and preserve both import and callback failures", async () => {
  const original = {
    _tag: "DatabaseError" as const,
    operation: "import" as const,
    message: "corrupt",
    cause: null,
  };
  const tools = createTransferTools(
    fake({ importBytes: () => Effect.fail(original) }),
  );
  let reconnected = false;
  tools.registerInterface(() => {
    reconnected = true;
    throw new Error("reconnect failed");
  });
  const error = await assertRejects(
    () => tools.importDatabase(new Uint8Array()),
    TransferImportError,
  );
  assertEquals(error.imported, false);
  assertEquals(reconnected, true);
  assertEquals(error.errors.length, 2);
});

Deno.test("queued export waits until import reconnect completes", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const order: string[] = [];
  const tools = createTransferTools(
    fake({
      exportBytes: () =>
        Effect.sync(() => {
          order.push("export");
          return new Uint8Array();
        }),
    }),
  );
  tools.registerInterface(async () => {
    order.push("refresh");
    await blocked;
    order.push("ready");
  });
  const imported = tools.importDatabase(new Uint8Array());
  const exported = tools.exportDatabase();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertEquals(order, ["refresh"]);
  release();
  await Promise.all([imported, exported]);
  assertEquals(order, ["refresh", "ready", "export"]);
});

Deno.test("Buffer-backed imports own bytes before returning to the caller", async () => {
  const seen: number[][] = [];
  const tools = createTransferTools(fake({
    importBytes: (bytes) =>
      Effect.sync(() => {
        seen.push([...bytes]);
      }),
  }));
  const bytes = Buffer.from([42]);
  const pending = tools.importDatabase(bytes);
  bytes[0] = 99;
  await pending;
  assertEquals(seen, [[42]]);
});

Deno.test("unregister during pending reconnect skips an uninvoked registration", async () => {
  const started = Promise.withResolvers<void>();
  const blocked = Promise.withResolvers<void>();
  const tools = createTransferTools(fake());
  const order: string[] = [];
  tools.registerInterface(async () => {
    order.push("first");
    started.resolve();
    await blocked.promise;
  });
  const unregister = tools.registerInterface(() => {
    order.push("disposed");
  });
  const pending = tools.importDatabase(new Uint8Array());
  await started.promise;
  unregister();
  blocked.resolve();
  await pending;
  assertEquals(order, ["first"]);
});

Deno.test("repeated callback registrations have independent disposal tokens", async () => {
  const tools = createTransferTools(fake());
  let calls = 0;
  const reconnect = () => {
    calls++;
  };
  const unregister = tools.registerInterface(reconnect);
  tools.registerInterface(reconnect);
  unregister();
  await tools.importDatabase(new Uint8Array());
  assertEquals(calls, 1);
});
