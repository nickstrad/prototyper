import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import type { sqlFailures, transcript } from "./scenario.ts";

type Transcript = {
  operations: Awaited<ReturnType<typeof transcript>>;
  failures: Awaited<ReturnType<typeof sqlFailures>>;
};

// D1 preserves backend diagnostics. Fiddle adds these engine-code prefixes;
// compare the error reason, operation, exit/status and committed state exactly.
const reason = (s: string) =>
  s.replace(/SQLITE_(?:ERROR|CONSTRAINT): sqlite3 result code (?:1|19): /g, "");
const failureSemantics = (f: Transcript["failures"]) => ({
  commands: f.commands.map((c) => ({ ...c, stderr: reason(c.stderr) })),
  api: {
    ...f.api,
    body: {
      error: { ...f.api.body.error, message: reason(f.api.body.error.message) },
    },
  },
});

test(
  "R9 browser import isolation and native outcome/error equivalence",
  async ({ page }, testInfo) => {
    const native: Transcript = JSON.parse(execFileSync("/root/.deno/bin/deno", [
      "run",
      "--allow-read",
      "tests/native/native-transcript.ts",
    ], { encoding: "utf8" }));
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("/tests/native/browser.html");
    await page.waitForFunction(() => "r9Transcript" in globalThis);
    const browser = await page.evaluate(() =>
      (globalThis as unknown as {
        r9Transcript(): Promise<Transcript>;
      }).r9Transcript()
    );
    for (const [name, body] of Object.entries({ native, browser })) {
      await testInfo.attach(`${name}-raw-transcript`, {
        body: JSON.stringify(body, null, 2),
        contentType: "application/json",
      });
    }
    expect(browser.operations).toEqual(native.operations);
    expect(failureSemantics(browser.failures)).toEqual(
      failureSemantics(native.failures),
    );
    expect(native.failures.commands.map((c) => c.exitCode)).toEqual([
      1,
      1,
      1,
      1,
      0,
    ]);
    expect(JSON.parse(native.failures.commands[4].stdout).rows).toEqual([[
      8,
      "partial",
    ]]);
    expect(native.failures.api.status).toBe(400);
    expect(native.failures.api.body.error.code).toBe("SqlError");
    expect(errors).toEqual([]);
  },
);
