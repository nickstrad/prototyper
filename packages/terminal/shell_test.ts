// Same just-bash + Effect command path as the browser, run natively in Deno.
import { assertEquals, assertStringIncludes } from "@std/assert";
import { AppClock, makeTasksRuntime } from "./examples/tasks.ts";
import { exampleCommands } from "./examples/tasks-command.ts";
import { command, ok } from "./effect-command.ts";
import { createShell } from "./shell.ts";

const setup = () => {
  const runtime = makeTasksRuntime(AppClock.fixed("2026-01-02T03:04:05.000Z"));
  return { runtime, shell: createShell(exampleCommands(runtime)) };
};

Deno.test("quoted args, pipelines, jq and failures through just-bash", async () => {
  const { runtime, shell } = setup();
  try {
    assertEquals((await shell.exec("hello Alice")).stdout, "Hello, Alice!\n");
    assertEquals(
      (await shell.exec('tasks create "Build API"')).stdout,
      "created 1: Build API\n",
    );
    await shell.exec("tasks create 'Write tests'");
    assertEquals(
      (await shell.exec("tasks list --json | jq '.[].title'")).stdout,
      '"Build API"\n"Write tests"\n',
    );
    assertEquals((await shell.exec("echo a | tr a-z A-Z")).stdout, "A\n");
    const missing = await shell.exec("tasks complete 42");
    assertEquals(missing.exitCode, 1);
    assertEquals(missing.stderr, "tasks: task 42 not found\n");
    const empty = await shell.exec('tasks create ""');
    assertEquals(empty.exitCode, 1);
    assertStringIncludes(empty.stderr, "invalid input");
    const usage = await shell.exec("tasks bogus");
    assertEquals(usage.exitCode, 2);
    // Exit status is visible to the shell itself.
    assertEquals(
      (await shell.exec("tasks complete 42 || echo recovered")).stdout,
      "recovered\n",
    );
  } finally {
    await runtime.dispose();
  }
});

Deno.test("custom commands receive piped stdin as UTF-8 text", async () => {
  const shell = createShell([
    command(
      "upper",
      (_args, stdin) => Promise.resolve(ok(stdin.toUpperCase())),
    ),
  ]);
  assertEquals((await shell.exec("echo héllo | upper")).stdout, "HÉLLO\n");
});
