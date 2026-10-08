/** Executable entry point; importing it does not open a database or listener. */
import { takeJsonFlag } from "../../packages/terminal/commands.ts";
import { createNativeHost, serveNativeHost } from "./mod.ts";

const USAGE = `usage: deno run --allow-read --allow-write adapters/deno/main.ts
  [--database PATH] tasks <command>    task CLI (R2 syntax)
  [--database PATH] db <command>       database CLI (R2 syntax)
  [--database PATH] serve [--port N] [--sql] [--stdio]

Default database: :memory:. serve binds 127.0.0.1 (requires --allow-net).
--sql enables the trusted local SQL inspection endpoint.
--stdio accepts one JSON argv array per line while the API runs on the SAME host;
prints one JSON CommandResult per line; EOF drains HTTP and closes the host.
`;

export async function main(argv: readonly string[]): Promise<number> {
  const args = [...argv];
  let path = ":memory:";
  if (args[0] === "--database") {
    args.shift();
    path = args.shift() ?? "";
    if (!path) {
      console.error(USAGE);
      return 2;
    }
  }
  const mode = args[0];
  let port = 5197;
  let sql = false;
  let stdio = false;
  if (mode === "serve") {
    for (let i = 1; i < args.length; i++) {
      if (args[i] === "--sql") sql = true;
      else if (args[i] === "--stdio") stdio = true;
      else if (args[i] === "--port") {
        const raw = args[++i] ?? "";
        port = /^\d+$/.test(raw) ? Number(raw) : NaN;
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          console.error(USAGE);
          return 2;
        }
      } else {
        console.error(USAGE);
        return 2;
      }
    }
  } else if (mode !== "tasks" && mode !== "db") {
    console.error(USAGE);
    return mode === "--help" ? 0 : 2;
  }
  const host = await createNativeHost({ path, sql });
  try {
    if (mode !== "serve") {
      const stdin = mode === "db" && args[1] === "sql" &&
          takeJsonFlag(args.slice(2)).rest.length === 0
        ? await new Response(Deno.stdin.readable).text()
        : "";
      const result = await host.command(args, stdin);
      await Deno.stdout.write(new TextEncoder().encode(result.stdout));
      await Deno.stderr.write(new TextEncoder().encode(result.stderr));
      return result.exitCode;
    }
    const server = serveNativeHost(host, { port });
    let reader: ReadableStreamDefaultReader<string> | undefined;
    let stopping = false;
    const stop = () => {
      stopping = true;
      void reader?.cancel();
      void server.shutdown();
    };
    Deno.addSignalListener("SIGINT", stop);
    Deno.addSignalListener("SIGTERM", stop);
    try {
      if (stdio) {
        let pending = "";
        const line = async (text: string) => {
          let argv: unknown;
          try {
            argv = JSON.parse(text);
          } catch { /* usage result below */ }
          const result = Array.isArray(argv) &&
              argv.every((a) => typeof a === "string")
            ? await host.command(argv)
            : {
              stdout: "",
              stderr: "expected a JSON string array\n",
              exitCode: 2,
            };
          console.log(JSON.stringify(result));
        };
        reader = Deno.stdin.readable.pipeThrough(new TextDecoderStream())
          .getReader();
        while (!stopping) {
          const { value, done } = await reader.read();
          if (done) break;
          pending += value;
          let end: number;
          while ((end = pending.indexOf("\n")) >= 0) {
            await line(pending.slice(0, end));
            pending = pending.slice(end + 1);
          }
        }
        if (pending && !stopping) await line(pending);
        await server.shutdown();
      }
      await server.finished;
      return 0;
    } finally {
      reader?.releaseLock();
      Deno.removeSignalListener("SIGINT", stop);
      Deno.removeSignalListener("SIGTERM", stop);
      await server.shutdown();
    }
  } finally {
    await host.dispose();
  }
}

if (import.meta.main) {
  try {
    Deno.exitCode = await main(Deno.args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    Deno.exitCode = 1;
  }
}
