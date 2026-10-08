// Application shell: just-bash interprets command lines, pipelines and
// utilities (jq, tr, ...) in the browser and natively under Deno. It never
// interprets the database console; that goes to the upstream engine shell.
import { Bash, type CustomCommand } from "just-bash";

export type { CustomCommand };

export const createShell = (commands: readonly CustomCommand[]): Bash =>
  new Bash({ customCommands: [...commands] });

export type Shell = Bash;
