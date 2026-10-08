// Explicit integration test (needs run/net beyond the default deno task test).
import { assertEquals, assertStringIncludes } from "@std/assert";

const deno = Deno.execPath();
const entry = "adapters/deno/main.ts";
const decoder = new TextDecoder();
const encoder = new TextEncoder();
const invoke = async (...args: string[]) => {
  const result = await new Deno.Command(deno, {
    args: ["run", "--allow-read", "--allow-write=/tmp", entry, ...args],
  }).output();
  return {
    code: result.code,
    stdout: decoder.decode(result.stdout),
    stderr: decoder.decode(result.stderr),
  };
};

if (import.meta.main) {
  const dir = await Deno.makeTempDir({ prefix: "r9-cli-" });
  try {
    const path = `${dir}/tasks.sqlite`;
    assertEquals(
      (await invoke("--database", path, "tasks", "create", "persisted")).code,
      0,
    );
    const result = await invoke(
      "--database",
      path,
      "tasks",
      "get",
      "4",
      "--json",
    );
    assertEquals(result.code, 0);
    assertEquals(JSON.parse(result.stdout).title, "persisted");
    assertEquals((await invoke("tasks", "get", "404")).code, 1);
    assertEquals((await invoke("tasks", "wat")).code, 2);
    assertEquals((await invoke("serve", "--port", "bad")).code, 2);
    assertEquals((await invoke("--help")).code, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }

  // Exercise real TCP plus the CLI in ONE process on an in-memory database.
  for (const ending of ["eof", "signal"] as const) {
    const child = new Deno.Command(deno, {
      args: [
        "run",
        "--allow-read",
        "--allow-net=127.0.0.1:5197",
        entry,
        "serve",
        "--port",
        "5197",
        "--stdio",
      ],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const writer = child.stdin.getWriter();
    const reader = child.stdout.pipeThrough(new TextDecoderStream())
      .getReader();
    const stderr = new Response(child.stderr).text();
    let exited = false;
    try {
      let ready = false;
      for (let i = 0; i < 100; i++) {
        try {
          const r = await fetch("http://127.0.0.1:5197/tasks");
          await r.arrayBuffer();
          ready = r.status === 200;
          if (ready) break;
        } catch { /* startup */ }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assertEquals(ready, true, "API startup");
      await writer.write(
        encoder.encode('["tasks","create","--json","TCP shared"]\n'),
      );
      let output = "";
      while (!output.includes("\n")) {
        const { value, done } = await reader.read();
        if (done) throw new Error("CLI ended before reply");
        output += value;
      }
      assertEquals(JSON.parse(output.trim()).exitCode, 0);
      const task = JSON.parse(JSON.parse(output.trim()).stdout);
      const get = await fetch(`http://127.0.0.1:5197/tasks/${task.id}`);
      assertEquals(await get.json(), task);
      const patch = await fetch(`http://127.0.0.1:5197/tasks/${task.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "HTTP changed" }),
      });
      assertEquals(patch.status, 200);
      await patch.arrayBuffer();
      await writer.write(encoder.encode('["tasks","get","4","--json"]\n'));
      output = "";
      while (!output.includes("\n")) {
        const { value, done } = await reader.read();
        if (done) throw new Error("CLI ended before reply");
        output += value;
      }
      assertEquals(
        JSON.parse(JSON.parse(output.trim()).stdout).title,
        "HTTP changed",
      );
      if (ending === "eof") await writer.close();
      else child.kill("SIGTERM");
      const status = await child.status;
      exited = true;
      assertEquals(status.code, 0, await stderr);
      assertStringIncludes(await stderr, "Listening on");
      console.log(`PASS actual CLI/API shared instance, ${ending} shutdown`);
    } finally {
      if (!exited) {
        child.kill("SIGKILL");
        await child.status;
      }
      writer.releaseLock();
      await reader.cancel();
      reader.releaseLock();
      await stderr;
    }
  }
  console.log("PASS executable persistence, usage and failure exit codes");
}
