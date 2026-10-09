import { Effect, type ManagedRuntime } from "effect";
import { Database } from "../../packages/database/sqlite-service.ts";
import {
  command,
  fail,
  runEffectCommand,
} from "../../packages/terminal/effect-command.ts";
import { databaseCommand } from "../../packages/terminal/commands.ts";
import { addInventory, listInventory, removeInventory } from "./application.ts";
const usage =
  "usage: inventory list [--json] | add SKU NAME QUANTITY | add --json (stdin object) | remove SKU\n";
export const commands = (
  runtime: ManagedRuntime.ManagedRuntime<Database, never>,
) => [
  command("inventory", (args, stdin) => {
    const run = <A, E extends { message: string }>(
      program: Effect.Effect<A, E, Database>,
    ) =>
      runEffectCommand(
        runtime,
        program.pipe(Effect.map((v) => JSON.stringify(v) + "\n")),
        (e) => `inventory: ${e.message}\n`,
      );
    if (
      args[0] === "list" &&
      (args.length === 1 || (args.length === 2 && args[1] === "--json"))
    ) return run(listInventory());
    if (args[0] === "remove" && args.length === 2) {
      return run(removeInventory(args[1]));
    }
    if (args[0] === "add" && args.length === 4) {
      return run(
        addInventory({
          sku: args[1],
          name: args[2],
          quantity: /^\d+$/.test(args[3]) ? Number(args[3]) : NaN,
        }),
      );
    }
    if (args[0] === "add" && args.length === 2 && args[1] === "--json") {
      try {
        return run(addInventory(JSON.parse(stdin)));
      } catch {
        return Promise.resolve(fail("inventory: invalid JSON input\n", 2));
      }
    }
    return Promise.resolve(fail(usage, 2));
  }),
  databaseCommand(runtime, Effect.service(Database)),
];
