// Same just-bash + Effect command path as the browser, run natively in Deno.
import { assertEquals, assertStringIncludes } from "@std/assert";
import { AppClock } from "../src/core/tasks.ts";
import { makeAppRuntime } from "../src/core/runtime.ts";
import { createShell } from "../src/terminal/shell.ts";

const setup = () => {
  const runtime = makeAppRuntime(AppClock.fixed("2026-01-02T03:04:05.000Z"));
  return { runtime, bash: createShell(runtime) };
};

Deno.test("quoted args, pipelines, jq and failures through just-bash", async () => {
  const { runtime, bash } = setup();
  try {
    assertEquals((await bash.exec("hello Alice")).stdout, "Hello, Alice!\n");
    assertEquals(
      (await bash.exec('tasks create "Build API"')).stdout,
      "created 1: Build API\n",
    );
    await bash.exec("tasks create 'Write tests'");
    assertEquals(
      (await bash.exec("tasks list --json | jq '.[].title'")).stdout,
      '"Build API"\n"Write tests"\n',
    );
    assertEquals((await bash.exec("echo a | tr a-z A-Z")).stdout, "A\n");
    const missing = await bash.exec("tasks complete 42");
    assertEquals(missing.exitCode, 1);
    assertEquals(missing.stderr, "tasks: task 42 not found\n");
    const empty = await bash.exec('tasks create ""');
    assertEquals(empty.exitCode, 1);
    assertStringIncludes(empty.stderr, "invalid input");
    // Exit status is visible to the shell itself.
    assertEquals(
      (await bash.exec("tasks complete 42 || echo recovered")).stdout,
      "recovered\n",
    );
  } finally {
    await runtime.dispose();
  }
});
