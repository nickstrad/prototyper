import { Layer, ManagedRuntime } from "effect";
import { nativeSqliteBackend } from "../../packages/database/native-sqlite.ts";
import { layer } from "../../packages/database/sqlite-service.ts";
import { createShell } from "../../packages/terminal/shell.ts";
import { commands } from "./commands.ts";
import { schema, seed } from "./schema.ts";
export function createInventory() {
  const runtime = ManagedRuntime.make(
    Layer.orDie(layer({ backend: nativeSqliteBackend(), schema, seed })),
  );
  return {
    runtime,
    shell: createShell(commands(runtime)),
    dispose: () => runtime.dispose(),
  };
}
