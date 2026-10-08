import { createNativeHost } from "../../adapters/deno/mod.ts";
import { TaskClock } from "../../prototypes/task-manager/application.ts";
import { sqlFailures, transcript } from "./scenario.ts";

if (import.meta.main) {
  const host = await createNativeHost({
    sql: true,
    clock: TaskClock.fixed("2026-01-01T00:00:00.000Z"),
  });
  try {
    console.log(
      JSON.stringify({
        operations: await transcript(host),
        failures: await sqlFailures(host),
      }),
    );
  } finally {
    await host.dispose();
  }
}
