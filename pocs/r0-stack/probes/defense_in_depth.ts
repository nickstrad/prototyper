// Probe: which just-bash defenseInDepth setting is quiet under Deno?
import { Bash } from "just-bash";
const mode = Deno.args[0] ?? "default";
const opt = mode === "auto"
  ? { defenseInDepth: { enabled: "auto" as const } }
  : mode === "off"
  ? { defenseInDepth: false }
  : {};
const r = await new Bash(opt).exec("echo hi | tr a-z A-Z");
console.log("RESULT", mode, JSON.stringify(r.stdout));
