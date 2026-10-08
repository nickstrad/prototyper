import { Bash } from "just-bash";
import type { AppRuntime } from "../core/runtime.ts";
import { appCommands } from "./commands.ts";

export const createShell = (runtime: AppRuntime): Bash =>
  new Bash({ customCommands: appCommands(runtime) });
